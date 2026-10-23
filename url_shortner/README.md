# URL Shortener: Problem Statement, Capacity Estimations & System Architecture

## 1. Executive Summary & Objective

A **URL Shortener** is a service that translates long, verbose URLs (often containing tracking parameters, nested path identifiers, and query strings) into concise, unique alphanumeric aliases (e.g., `[https://algo.ms/7xK9q2](https://algo.ms/7xK9q2)`). When a client queries this alias, the system must translate the short identifier back to the long URL and issue an HTTP redirect.

While conceptually simple at low traffic, building this for production is an industry-standard test for distributed systems design due to:

* Extreme read/write asymmetry ($\approx 100:1$).
* Strict low-latency SLAs ($p99 < 50\text{ ms}$).
* Massive cumulative storage and key-space sizing over time.
* High concurrency locking and collision hazards.

---

## 2. Requirements Specification

### 2.1 Functional Requirements (FR)

1. **Shorten URL:** Accept a target long URL and output a uniquely generated, compact short URL.
2. **Redirection:** When accessing `GET /{short_code}`, redirect the client to the canonical destination with an HTTP `302 Found` (or `301 Moved Permanently`).
3. **Custom Aliases:** Allow users to submit an optional vanity alias (e.g., `/black-friday-sale`) subject to uniqueness constraints.
4. **Link Expiration:** Support an optional expiration timestamp (`expires_at`). Expired links must not redirect and should return `410 Gone`.
5. **Basic Analytics:** Record the aggregate click counter per link without impacting redirect performance.

### 2.2 Non-Functional Requirements (NFR)

1. **High Availability ($99.99\%$):** The redirect path must stay operational even during database failovers or network partitions.
2. **Ultra-Low Latency:** Redirect resolution must be served within $< 50\text{ ms}$ at the 99th percentile ($p99$), and $< 15\text{ ms}$ on median cache hits.
3. **Collision Resistance & Uniqueness:** No two distinct target URLs may map to the same short code unless intentionally deduplicated; custom aliases must be atomic.
4. **Durability:** Once confirmed, a mapping must never be lost or silently corrupted.

---

## 3. Back-of-the-Envelope Calculations (Scale & Resource Profiling)

To design the database and server capacity realistically, we establish engineering numbers based on industry scale assumptions.

### 3.1 Traffic & Throughput Estimations

* **New URLs Created (Writes):** $10\text{ million}$ links/day.
* **Read-to-Write Ratio:** $100 : 1$.
* **Redirect Requests (Reads):** $10\text{ million} \times 100 = 1\text{ billion}$ clicks/day.

#### Write Throughput (QPS - Queries Per Second)

$$
\text{Average Write QPS} = \frac{10{,}000{,}000\text{ requests}}{24 \times 3600\text{ seconds}} \approx \frac{10{,}000{,}000}{86{,}400} \approx 116\text{ writes/sec}
$$

Accounting for peak traffic surges ($3\times$ factor):

$$
\text{Peak Write QPS} = 116 \times 3 \approx 350\text{ writes/sec}
$$

#### Read Throughput (Redirect QPS)

$$
\text{Average Read QPS} = \frac{1{,}000{,}000{,}000\text{ requests}}{86{,}400\text{ seconds}} \approx 11{,}574\text{ reads/sec}
$$

Accounting for peak traffic surges ($3\times$ factor):

$$
\text{Peak Read QPS} = 11{,}574 \times 3 \approx 34{,}720 \approx 35{,}000\text{ reads/sec}
$$

---

### 3.2 Storage Capacity Estimations

Payload size estimate per entry:

* `short_code`: 7 bytes (ASCII characters)
* `long_url`: 200 bytes (average web URL length)
* `user_id`: 36 bytes (UUID v4)
* `created_at`: 8 bytes (timestamp integer)
* `expires_at`: 8 bytes (timestamp integer)
* `click_count`: 8 bytes (64-bit counter)
* Database index and metadata overhead: $\approx 33\text{ bytes}$
* **Total row size:** $\approx 300\text{ bytes}$ per record.

#### Storage Accumulation

* **URLs generated per year:**

$$
10{,}000{,}000 \times 365 = 3.65\text{ billion URLs/year}
$$

* **Annual Storage Footprint:**

$$
3.65 \times 10^9 \text{ records} \times 300\text{ bytes} \approx 1{,}095{,}000{,}000{,}000\text{ bytes} \approx 1.1\text{ TB/year}
$$

* **5-Year Cumulative Capacity:**

$$
1.1\text{ TB} \times 5 = 5.5\text{ TB}
$$

> **Laptop Constraint Model:** Stress-testing local hardware (16 GB RAM, 1 TB storage) focuses on matching the **rate** ($\text{requests/sec}$) rather than holding multi-terabyte datasets. A dataset of $100{,}000$ to $1{,}000{,}000$ rows stresses I/O, connection pools, and CPU caches on local hardware.

---

### 3.3 Memory & Cache Estimation (Pareto 80/20 Rule)

In URL shortener traffic, $20\%$ of hot links generate $80\%$ of redirect volume.

* **Daily Redirects:** $1\text{ billion}$
* **20% Hot Links Volume:** $200\text{ million}$ unique URLs active per day.
* **Memory required to cache 20% of daily active links:**

$$
200{,}000{,}000 \times 300\text{ bytes} = 60\text{ GB RAM}
$$

For our local testing on a 16 GB machine, we allocate $256\text{ MB} - 512\text{ MB}$ to Redis, sufficient to cache hot links and test eviction policies (LRU) under load.

---

### 3.4 Key-Space Capacity: Why Base62?

We use Base62 encoding:

* Digits: `0-9` (10 characters)
* Lowercase: `a-z` (26 characters)
* Uppercase: `A-Z` (26 characters)
* **Total pool:** $10 + 26 + 26 = 62\text{ characters}$.

Base62 avoids the `+` and `/` characters of Base64, which require URL encoding in web browsers.

#### Key Length Calculations:

* With length $n = 6$:

$$
62^6 = 56{,}800{,}235{,}584 \approx 56.8\text{ billion unique URLs}
$$

*(Exhausted in $\approx 15$ years at 10M writes/day)*

* With length $n = 7$:

$$
62^7 = 3{,}521{,}614{,}606{,}208 \approx 3.52\text{ trillion unique URLs}
$$

*(Exhausted in $\approx 960$ years at 10M writes/day)*

A **7-character Base62 string** gives long-term headroom with zero byte waste.

---

## 4. Why Naive Systems Collapse Under Load

When built naively in Node.js (e.g., Express + direct ORM/PostgreSQL queries without caching or concurrency decoupling), the system crashes under moderate traffic spikes:

### 1. Database Connection & Disk I/O Saturation

At high QPS, querying a database directly forces disk index traversals. Database connection pools (e.g., default pool size of 10) are quickly exhausted, leading to request queue stalls and connection drops.

### 2. Row-Lock Contention on Click Counters

When updates run synchronously during redirection:

```sql
UPDATE urls SET clicks = clicks + 1 WHERE short_code = 'xyz';
```

Every concurrent request for the same link waits on an exclusive row write lock. Relational ACID serialization transforms concurrent reads into a blocking write queue.

### 3. Write Bottleneck: The "Check-Then-Act" Anti-Pattern

Under naive implementations, the write path checks existence prior to insertion:

```javascript
while (attempts < MAX_ATTEMPTS) {
  const candidate = generateShortCode(7);
  const exists = await prisma.url.findUnique({ where: { shortCode: candidate } });
  if (!exists) { break; }
}
await prisma.url.create({ ... });

```

This forces up to 5 speculative read roundtrips per write. Under heavy concurrent writes, two requests can evaluate the same code as free simultaneously, producing unique constraint collisions (`P2002`).

### 4. Cache Cold-Starts on New Links

If caching is only applied during reads (pure Cache-Aside), every freshly created link triggers a guaranteed database cache miss on its first access surge, routing initial traffic straight to disk.

---

## 5. Architectural Strategy: Dual Read/Write Optimization

```
                                  +-------------------+
                                  |      Client       |
                                  +---------+---------+
                                            |
                                            v
                            +---------------+---------------+
                            |   Load Balancer (Reverse Proxy)|
                            +---------------+---------------+
                                            |
                    +-----------------------+-----------------------+
                    |                                               |
         [Write Path: POST /shorten]                      [Read Path: GET /:code]
                    |                                               |
                    v                                               v
        +-----------------------+                       +-----------------------+
        | URL Generator Service |                       |  Redirection Service  |
        +-----------+-----------+                       +-----------+-----------+
                    |                                               |
         +----------+----------+                                    |
         |                     |                          (1) Check Cache First
         v                     v                                    |
   +-----------+         +-----------+                              v
   | ID Engine |         | Database  | <--------------------+---------------+
   | (Atomic   |         | (Postgres |      (2) Cache Miss  |  Redis Cache  |
   |  Counter) |         |  Storage) |                      +---------------+
   +-----------+         +-----+-----+                              |
                               ^                                    |
                               |                          (3) Async Ingest
                               |                                    |
                               +------------------------------------+
                                   Buffered Click Counter Flush
```

### 5.1 Write Path Optimizations

1. **Collision-Free Generation via Atomic Counters:** Replace random string guesses with an atomic Redis sequence counter (`INCR url_counter`) converted to Base62. Guarantees unique, $O(1)$ generation without database collision checks.
2. **Proactive Cache Warming:** Immediately upon writing the new link to PostgreSQL, store it in Redis (`SET link:{short_code} {long_url}`). The very first read hits RAM instantly, eliminating cold-start database latency.

### 5.2 Read Path Optimizations

1. **Cache-Aside Resolution:** Lookups check Redis first ($< 1\text{ ms}$). Only cache misses trigger a PostgreSQL read.
2. **Decoupled Analytics via Buffered Counting:** Remove all database updates from the redirect loop. Atomically increment an in-memory counter (`INCR link:{short_code}:clicks`) in Redis and return the redirect immediately.
3. **Background Batch Flusher:** A periodic worker reads Redis click counters every 10 seconds and flushes updates to PostgreSQL in a single batch query.

---

## 6. Baseline Implementation & Empirical Load Testing

To evaluate the naive implementation and capture real-world bottlenecks, we executed load tests against the initial Express + Prisma + PostgreSQL code on local hardware (16 GB RAM).

### 6.1 Test Setup & Tooling

* **Benchmarking Tool:** `autocannon`
* **Target Endpoint:** `GET http://localhost:9090/nodejs-about` (HTTP `302 Found` redirect)
* **Concurrency Parameters:** 100 concurrent connections (`-c 100`), 10-second run duration (`-d 10`), pipelining factor of 10 (`-p 10`).
* **Load Command:**

```bash
npx autocannon -c 100 -d 10 -p 10 http://localhost:9090/nodejs-about
```

---

### 6.2 Experiment 1: Baseline Architecture (Read + Inline Atomic Write)

In the initial naive implementation, every redirect executed two back-to-back database queries:

1. `prisma.url.findUnique(...)` to fetch the destination URL.
2. `prisma.url.update(...)` to execute an inline atomic click counter increment (`clicks: { increment: 1 }`).

#### Autocannon Results:

```text
┌─────────┬───────┬────────┬─────────┬─────────┬───────────┬───────────┬─────────┐
│ Stat    │ 2.5%  │ 50%    │ 97.5%   │ 99%     │ Avg       │ Stdev     │ Max     │
├─────────┼───────┼────────┼─────────┼─────────┼───────────┼───────────┼─────────┤
│ Latency │ 90 ms │ 531 ms │ 1304 ms │ 1367 ms │ 607.49 ms │ 309.35 ms │ 4388 ms │
└─────────┴───────┴────────┴─────────┴─────────┴───────────┴───────────┴─────────┘
┌───────────┬─────────┬─────────┬────────┬────────┬─────────┬────────┬─────────┐
│ Stat      │ 1%      │ 2.5%    │ 50%    │ 97.5%  │ Avg     │ Stdev  │ Min     │
├───────────┼─────────┼─────────┼────────┼────────┼─────────┼────────┼─────────┤
│ Req/Sec   │ 39      │ 39      │ 1,714  │ 2,149  │ 1,588.1 │ 645.95 │ 39      │
├───────────┼─────────┼─────────┼────────┼────────┼─────────┼────────┼─────────┤
│ Bytes/Sec │ 11.2 kB │ 11.2 kB │ 492 kB │ 617 kB │ 456 kB  │ 185 kB │ 11.2 kB │
└───────────┴─────────┴─────────┴────────┴────────┴─────────┴────────┴─────────┘

Req/Bytes counts sampled once per second. # of samples: 10
0 2xx responses, 15,879 non-2xx responses (HTTP 302 Redirects)
17k requests in 10.05s, 4.56 MB read
```

#### Diagnostic Query (PostgreSQL Internal Lock Activity):

Active database sessions were queried during peak execution:

```sql
SELECT pid, wait_event_type, wait_event, state, query 
FROM pg_stat_activity 
WHERE state != 'idle' AND query LIKE '%urls%';

```

#### Database Lock Inspection Output:

```text
 pid | wait_event_type |  wait_event   | state  | query
-----+-----------------+---------------+--------+-------------------------------------------------------------
  67 | LWLock          | LockManager   | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  74 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  71 | null            | null          | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  73 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  76 | null            | null          | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  70 | Lock            | transactionid | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  72 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  68 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  75 | null            | null          | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  69 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  77 | null            | null          | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  78 | Lock            | transactionid | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  83 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  82 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  81 | null            | null          | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  79 | Lock            | tuple         | active | UPDATE "public"."urls" SET "clicks" = ("public"."urls"...
  96 | null            | null          | active | SELECT pid, wait_event_type, wait_event, state, query...

```

#### Experiment 1 Findings:

* **Lock Contention:** PostgreSQL processes stalled on `wait_event_type = Lock` (`tuple` and `transactionid`) and `LWLock` (`LockManager`). All 100 concurrent workers competed for the same physical row lock on disk.
* **Latency Spikes:** Median latency reached **531 ms**, with a peak tail latency of **4,388 ms** (4.4 seconds).
* **Stalling Throughput:** Minimum throughput dropped to **39 req/sec**, showing near-total lock stalls during high concurrency.
* **Total Throughput:** Capped at an average of **1,588.1 req/sec**.

---

### 6.3 Experiment 2: Isolation Test (Write Step Commented Out)

To verify row locking as the primary bottleneck, `prisma.url.update(...)` was commented out in `redirectUrl`, leaving pure database reads.

#### Autocannon Results:

```text
┌─────────┬────────┬────────┬─────────┬─────────┬───────────┬───────────┬─────────┐
│ Stat    │ 2.5%   │ 50%    │ 97.5%   │ 99%     │ Avg       │ Stdev     │ Max     │
├─────────┼────────┼────────┼─────────┼─────────┼───────────┼───────────┼─────────┤
│ Latency │ 221 ms │ 347 ms │ 1389 ms │ 6225 ms │ 483.06 ms │ 872.49 ms │ 9885 ms │
└─────────┴────────┴────────┴─────────┴─────────┴───────────┴───────────┴─────────┘
┌───────────┬────────┬────────┬────────┬────────┬─────────┬────────┬────────┐
│ Stat      │ 1%     │ 2.5%   │ 50%    │ 97.5%  │ Avg     │ Stdev  │ Min    │
├───────────┼────────┼────────┼────────┼────────┼─────────┼────────┼────────┤
│ Req/Sec   │ 1,279  │ 1,279  │ 1,974  │ 2,431  │ 1,978.7 │ 375.02 │ 1,279  │
├───────────┼────────┼────────┼────────┼────────┼─────────┼────────┼────────┤
│ Bytes/Sec │ 367 kB │ 367 kB │ 567 kB │ 698 kB │ 568 kB  │ 108 kB │ 367 kB │
└───────────┴────────┴────────┴────────┴────────┴─────────┴────────┴────────┘

Req/Bytes counts sampled once per second. # of samples: 10
0 2xx responses, 19,785 non-2xx responses (HTTP 302 Redirects)
21k requests in 10.04s, 5.68 MB read
```

#### Experiment 2 Findings:

* **Lock Elimination:** Minimum throughput stabilized at **1,279 req/sec** (up from 39 req/sec), eliminating complete thread freezes.
* **Average Throughput:** Rose 25% to **1,978.7 req/sec**.
* **Secondary Bottleneck Isolated:** Median latency remained high at **347 ms** and peak latency reached **9,885 ms**. Database query roundtrips, connection pool constraints, and ORM query serialization capped throughput under 2,000 req/sec.

---

### 6.4 Comparative Summary

| Metric                         | Target SLA                      | Baseline (Read + Write)         | Read-Only Isolation                |
| ------------------------------ | ------------------------------- | ------------------------------- | ---------------------------------- |
| **Throughput (Avg)**     | $\ge 11{,}500\text{ req/sec}$ | 1,588.1 req/sec                 | 1,978.7 req/sec                    |
| **Throughput (Min)**     | Stable                          | 39 req/sec (freeze)             | 1,279 req/sec                      |
| **Median Latency (p50)** | $< 15\text{ ms}$              | 531 ms                          | 347 ms                             |
| **Peak Latency (Max)**   | $< 50\text{ ms}$              | 4,388 ms                        | 9,885 ms                           |
| **Primary Bottleneck**   | N/A                             | Row-Lock Contention (`tuple`) | DB Disk I/O & Prisma Pool Overhead |

---

## 7. Next Implementation Steps: Simultaneous Dual-Path Optimization

To address both bottlenecks and push throughput toward the **11,500+ req/sec** target, we will deploy the following updates:

1. **Deploy Redis In-Memory Engine:** Run Redis container alongside PostgreSQL on port 6379.
2. **Optimize the Write Path (`POST /shorten`):**

* Use an atomic Redis counter for collision-free Base62 ID generation, removing "check-then-act" database queries.
* Proactively warm Redis on insert (`SET link:{short_code} {long_url}`) to ensure zero-latency initial reads.

3. **Optimize the Read Path (`GET /:short_code`):**

* Direct requests to Redis via Cache-Aside, bypassing PostgreSQL for all cached records.
* Buffer analytics via `INCR link:{short_code}:clicks` in Redis, removing row updates from the request lifecycle.

4. **Deploy Background Batch Flusher:**

* Periodically sync in-memory click counts to PostgreSQL in batches every 10 seconds.

5. **Run Benchmark Verification:** Measure latency and throughput under identical 100-connection load.

---

## 8. Milestone 2: Dual Read-Write Optimization & Concurrency Benchmarks

### 8.1 Architectural Enhancements Implemented

1. **Atomic Sequence Generation:** Replaced speculative Base62 generation and database lookup loops with an atomic Redis counter (`INCR global_url_counter`), mapped directly to Base62 strings.
2. **Proactive Cache Warming:** Upon link creation, the URL mapping is immediately written to Redis with a 24-hour TTL (`SETEX link:{code} 86400 {long_url}`), eliminating cold-start database queries on initial redirect.
3. **Cache-Aside Redirection:** Read traffic resolves strictly against Redis memory. Cache misses fall back to PostgreSQL and backfill the cache.
4. **Decoupled Asynchronous Analytics:** Redirects increment an in-memory counter (`INCR clicks:{code}`). A background worker flushes batched metrics to PostgreSQL every 10 seconds via non-blocking `SCAN` and `GETDEL`.

---

### 8.2 Pure Write Benchmark (`POST /shorten`)

- **Load Profile:** 50 concurrent connections over 10 seconds.
- **Observed Average Throughput:** **3,174.4 writes/sec** (Target: 350 writes/sec).
- **Observed Median Latency ($p50$):** **14 ms**.
- **Total Writes Processed:** 32,000 records in 10.04s.

---

### 8.3 Mixed Workload Benchmark (Concurrent Reads & Writes)

- **Load Profile:** 10 concurrent write connections competing against 100 concurrent pipelined read connections over 15 seconds.
- **Read Throughput Under Write Load:** **16,438.94 req/sec** (Target: 11,574 req/sec).
- **Read Median Latency ($p50$):** **55 ms**.
- **Total Redirects Handled:** 248,000 requests in 15.05s.
- **Total Writes Handled:** 4,000 requests in 15.03s.

---

### 8.4 Engineering Takeaway

Decoupling the read and write paths using memory caching and asynchronous buffer flushes isolated CPU and I/O domains. Database disk writes no longer produce row-lock contention on active redirects, allowing both paths to exceed the project's capacity requirements on single-host hardware.


---

## 9. Milestone 3: Horizontal Clustering & Multi-Core Benchmarks

### 9.1 Multi-Process Architecture

- Converted `src/server.js` to utilize Node.js built-in `node:cluster` module.
- Primary process supervises 4 worker processes distributing incoming TCP connections via OS Round-Robin.
- Periodic cron tasks (`analyticsFlusher` and `cleanupWorker`) run exclusively on the Primary process to avoid duplicate executions.
- Implemented Section 7.1 hybrid link expiration: dynamic Redis TTL matching remaining link lifetime, passive `410 Gone` eviction, and active background database purges.

### 9.2 High-Concurrency Read Benchmark (`npx autocannon -c 200 -d 10 -p 10`)

- **Connections:** 200 concurrent connections, 10 pipelined requests.
- **Observed Average Throughput:** **39,620 req/sec** (Peak second: **44,639 req/sec**).
- **Observed Median Latency ($p50$):** **41 ms**.
- **Total Redirects Handled:** 398,000 requests in 10.19 seconds.

### 9.3 Final Architectural Scorecard

| Milestone             | Architecture State                                  | Read Throughput          | Median Latency ($p50$) | Max Latency      | Target Status               |
| :-------------------- | :-------------------------------------------------- | :----------------------- | :----------------------- | :--------------- | :-------------------------- |
| **Milestone 1** | Naive Monolith (Postgres writes inline)             | 1,588 req/sec            | 531 ms                   | 4,388 ms         | Failed (Row locks)          |
| **Milestone 2** | Redis Cache-Aside + Buffered Clicks (1 Core)        | 16,344 req/sec           | 56 ms                    | 250 ms           | Met average SLA             |
| **Milestone 3** | **Multi-Core Cluster + Redis + Auto Cleanup** | **39,620 req/sec** | **41 ms**          | **375 ms** | **Exceeded Peak SLA** |
