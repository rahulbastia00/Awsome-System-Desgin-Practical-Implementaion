
# URL Shortener: Problem Statement, Capacity Estimations & System Architecture

## 1. Executive Summary & Objective

A **URL Shortener** is a service that translates long, verbose URLs (often containing tracking parameters, nested path identifiers, and query strings) into concise, unique alphanumeric aliases (e.g., `https://algo.ms/7xK9q2`). When a client queries this alias, the system must translate the short identifier back to the long URL and issue an HTTP redirect.

While conceptually trivial at low traffic, building this for production is an industry standard test for distributed systems design due to:

* Extreme read/write asymmetry ($\approx 100:1$).
* Strict low-latency SLAs ($p99 < 50\text{ ms}$).
* Massive cumulative storage and key-space sizing over time.
* High concurrency locking and collision hazards.

## 2. Requirements Specification

### 2.1 Functional Requirements (FR)

1. **Shorten URL:** Accept a target long URL and output a uniquely generated, compact short URL.
2. **Redirection:** When accessing `GET /{short_code}`, redirect the client to the canonical destination with an HTTP `302 Found` (or `301 Moved Permanently`).
3. **Custom Aliases:** Allow users to submit an optional vanity alias (e.g., `/black-friday-sale`) subject to uniqueness constraints.
4. **Link Expiration:** Support a Time-To-Live (TTL) field. Expired links must not redirect and should return `410 Gone` or `404 Not Found`.
5. **Basic Analytics:** Record the aggregate click counter per link without impacting redirect performance.

### 2.2 Non-Functional Requirements (NFR)

1. **High Availability (**$99.99\%$**):** The redirect path must stay operational even during database failovers or network partitions.
2. **Ultra-Low Latency:** Redirect resolution must be served within $< 50\text{ ms}$ at the 99th percentile ($p99$).
3. **Collision Resistance & Uniqueness:** No two distinct target URLs may map to the same short code unless intentionally deduplicated; custom aliases must be atomic.
4. **Durability:** Once confirmed, a mapping must never be lost or silently corrupted.

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

### 3.2 Storage Capacity Estimations

Let us estimate the schema payload per entry:

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

> **Laptop Context:** You do not need 5.5 TB on your laptop right now. In development and benchmark stages, our target is to stress-test the *rate* ($\text{requests/sec}$) rather than holding multi-terabyte datasets. A dataset of $100{,}000$ to $1{,}000{,}000$ rows (tens of megabytes) will saturate I/O, cache hit ratios, and CPU cores on local hardware.

### 3.3 Memory & Cache Estimation (Pareto 80/20 Rule)

In typical URL shortener traffic, $20\%$ of hot links generate $80\%$ of redirect volume (e.g., viral campaigns, news links).

* **Daily Redirects:** $1\text{ billion}$
* $20\%$ **Hot Links Volume:** $200\text{ million}$ unique URLs active per day.
* **Memory required to cache 20% of daily active links:**

  $$
  200{,}000{,}000 \times 300\text{ bytes} = 60\text{ GB RAM}
  $$

A single production cache tier with $64\text{ GB}$ to $128\text{ GB}$ of Redis instances easily satisfies this cache hit ratio. For local testing on a $16\text{ GB}$ machine, we limit our Redis memory target to $256\text{ MB} - 512\text{ MB}$, intentionally filling it to observe eviction policies (LRU/LFU) under load.

### 3.4 Key-Space Capacity: Why Base62?

We use Base62 encoding, utilizing standard characters:

* Digits: `0-9` (10 characters)
* Lowercase: `a-z` (26 characters)
* Uppercase: `A-Z` (26 characters)
* **Total pool:** $10 + 26 + 26 = 62\text{ characters}$.

Why Base62 instead of Base64? Base64 incorporates `+` and `/`, which are reserved URL delimiters requiring URL percent-encoding (`%2B`, `%2F`), causing issues in browser addressing bars.

#### Length Calculation:

* With length $n = 6$:

  $$
  62^6 = 56{,}800{,}235{,}584 \approx 56.8\text{ billion unique URLs}
  $$

  *(Exhausted in* $\approx 15$ *years at 10M/day)*
* With length $n = 7$:

  $$
  62^7 = 3{,}521{,}614{,}606{,}208 \approx 3.52\text{ trillion unique URLs}
  $$

  *(Sufficient for* $\approx 960$ *years at 10M/day)*

Therefore, a **7-character Base62 string** gives adequate headroom with zero waste.

## 4. Why Naive Systems Collapse Under Load

When built naively in Node.js (e.g., Express + simple SQL/NoSQL without caching or concurrency protection), the system crashes under small traffic spikes. Here is why:

### 1. Database Connection & Disk I/O Saturation

* At $10{,}000\text{ to }35{,}000\text{ QPS}$, querying a database directly forces disk reads (or cache lookups inside the DBMS).
* Database connection pools (e.g., `pg` pool size default: 10) are instantly exhausted. Incoming requests queue up, socket timeouts fire, and the API yields `504 Gateway Timeout` or `ECONNREFUSED`.

### 2. Node.js Single-Thread Event Loop Starvation

* Node.js executes JavaScript on a single thread.
* If every request performs synchronous cryptographic hashing, complex string formatting, or waits on unindexed database lookups, the event loop lag spikes from $1\text{ ms}$ to $> 1{,}000\text{ ms}$, starving all concurrent network I/O.

### 3. Row-Lock Contention on Click Counters

* When a naive architecture updates click counts inline:

  ```
  UPDATE url_mappings SET click_count = click_count + 1 WHERE short_code = 'xyz';

  ```

  Every concurrent request for the same viral link waits for an exclusive row write lock. Instead of reading freely, reads become serialized behind write locks, crashing performance.

### 4. Hash Collisions and Race Conditions

* Generating hashes (e.g., MD5/SHA256 truncated to 7 characters) mathematically guarantees eventual collisions due to the Birthday Paradox.
* Under heavy concurrent writes, two users requesting aliases or hashes can hit a race condition: both check for existence, see the row does not exist, and simultaneously attempt to write, leading to unique constraint crashes.

## 5. Architectural Strategy: How We Will Solve It

Our project addresses each failure mode incrementally through targeted system design patterns:

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
         [Write Path: POST /shorten]                     [Read Path: GET /:code]
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
   | (Base62)  |         | (Postgres |     (2) Cache Miss   |  Redis Cache  |
   +-----------+         | /NoSQL)   |                      +---------------+
                         +-----+-----+                              |
                               ^                          (3) Async Ingest
                               |                                    |
                               +------------------------------------+
                                    Buffered Click Counter Flush

```

### 1. Read Path Optimization (Sub-10ms Latency)

* Introduce **Redis Cache-Aside**: Read queries check in-memory cache first ($< 1\text{ ms}$). Only cache misses query the persistent database.
* The database sees $< 1\%$ of read traffic.

### 2. ID Generation Without Collisions

* **Deterministic approach:** Distributed atomic counters (Redis `INCR` or Snowflake ID) converted to Base62.
* Guarantees $O(1)$ generation with mathematical zero collisions and no retry loops.

### 3. Decoupled Click Analytics

* Remove synchronous updates from the redirect loop.
* Redirections complete immediately while click metrics are stored via atomic Redis counters (`INCR link:xyz:clicks`) or an append-only log, then periodically flushed in bulk to disk via a background worker.

### 4. Process Multi-Threading

* Scale Node.js horizontally across all CPU cores of your laptop using the `cluster` module or a containerized reverse proxy.

## 6. Execution Roadmap for Local Development

| Phase             | System State                           | Milestone Goal                                                                                    |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **Phase 1** | **Naive Baseline**               | Node.js + Express + Direct Database. Pure, simple logic.                                          |
| **Phase 2** | **Stress Testing & Failure**     | Run `autocannon` to find the exact QPS where the event loop starves and connection pools break. |
| **Phase 3** | **Read Cache Tier**              | Add Redis to deflect $99\%$ of reads; benchmark latency difference ($p50, p99$).              |
| **Phase 4** | **Decoupled Analytics**          | Replace database row updates with async Redis buffering; test concurrency throughput.             |
| **Phase 5** | **Distributed IDs & Clustering** | Implement Base62 counter generation and multi-core Node clustering to maximize CPU capacity.      |
