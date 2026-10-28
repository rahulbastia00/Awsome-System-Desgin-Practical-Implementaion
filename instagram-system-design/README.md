
# Instagram System Design — Phase 4 & Phase 5 Load Test Results

## Phase 4: High-Concurrency Redis Feed Reads

### Test Configuration

- **Test Script:** `load-test-phase4.js`
- **Endpoint:** `http://localhost:3000/api/v1/feed?page=1&limit=10`
- **Concurrency:** 50 connections
- **Duration:** 20 seconds
- **Objective:** Test feed-read performance using Redis.

### Latency Statistics

| Metric                   |  Result |
| ------------------------ | ------: |
| 2.5th Percentile         |    4 ms |
| Median (50th Percentile) |    4 ms |
| 97.5th Percentile        |    7 ms |
| 99th Percentile (p99)    |    9 ms |
| Average Latency          | 4.46 ms |
| Standard Deviation       | 3.74 ms |
| Maximum Latency          |  245 ms |

### Throughput Statistics

| Metric                       |    Result |
| ---------------------------- | --------: |
| Average Requests/Second      |     9,869 |
| Median Requests/Second       |    10,351 |
| Peak Sampled Requests/Second |    10,663 |
| Average Data Throughput      | 39.3 MB/s |
| Total Requests               |   197,368 |
| Data Transferred             |    785 MB |
| Successful 2xx Responses     |   197,368 |
| Errors / Timeouts            |         0 |

### Results Summary

The Phase 4 test completed with 197,368 successful requests over approximately 20 seconds. The feed endpoint achieved an average latency of 4.46 ms and average throughput of 9,869 requests per second, with no reported errors or timeouts.

These results demonstrate strong local feed-read performance under the tested conditions.

---

## Phase 5: Global Multi-Vector Production Stress Test

### Test Configuration

- **Test Script:** `load-test-phase5-global.js`
- **Base URL:** `http://localhost:3000`
- **Concurrency:** 50 connections
- **Duration:** 20 seconds
- **Objective:** Evaluate performance across multiple backend operations under mixed traffic.

### Traffic Distribution

| Operation                                                   | Traffic Share |
| ----------------------------------------------------------- | ------------: |
| Pre-Signed Media Generation                                 |           40% |
| JSON Post Creation and Asynchronous Redis Stream Publishing |           10% |
| Hybrid Celebrity / Normal Timeline Feed Reads               |           40% |
| Atomic Engagement Likes                                     |           10% |

### Latency Statistics

| Metric                   |   Result |
| ------------------------ | -------: |
| 2.5th Percentile         |    13 ms |
| Median (50th Percentile) |    26 ms |
| 97.5th Percentile        |    70 ms |
| 99th Percentile (p99)    |    83 ms |
| Average Latency          | 30.29 ms |
| Standard Deviation       | 16.82 ms |
| Maximum Latency          |   232 ms |

### Throughput Statistics

| Metric                                       |    Result |
| -------------------------------------------- | --------: |
| Average Requests/Second                      |  1,623.85 |
| Median Requests/Second                       |     1,683 |
| 97.5th Percentile of Sampled Requests/Second |     1,969 |
| Average Data Throughput                      | 1.83 MB/s |
| Total Requests                               |    32,477 |
| Data Transferred                             |   36.7 MB |
| Successful 2xx Responses                     |    19,495 |
| Non-2xx Responses / Errors                   |    12,982 |

### Results Summary

The Phase 5 test completed approximately 32,477 requests across the four operation categories. It achieved an average throughput of 1,623.85 requests per second, with average latency of 30.29 ms and p99 latency of 83 ms.

However, **12,982 requests returned non-2xx responses**, representing approximately 39.97% of all requests. Only 60.03% returned successful 2xx responses.

This failure rate requires investigation before the system can be considered reliable under mixed workloads. Non-2xx responses are not necessarily server errors; they may include validation failures, authentication failures, rate limits, or other expected HTTP responses.

---

## Phase 4 vs. Phase 5 Comparison

| Metric                     |         Phase 4 |                  Phase 5 |
| -------------------------- | --------------: | -----------------------: |
| Workload                   | Feed reads only | Mixed backend operations |
| Concurrency                |  50 connections |           50 connections |
| Duration                   |     ~20 seconds |              ~20 seconds |
| Average Throughput         |     9,869 req/s |           1,623.85 req/s |
| Average Latency            |         4.46 ms |                 30.29 ms |
| p99 Latency                |            9 ms |                    83 ms |
| Total Requests             |         197,368 |                   32,477 |
| Successful Responses       |            100% |                   60.03% |
| Non-2xx Responses / Errors |               0 |                   12,982 |

### Key Observations

1. **Feed reads are fast in isolation.** Phase 4 achieved low average latency and high throughput for the tested feed endpoint.
2. **Mixed workloads reduce throughput.** Phase 5 introduces several different operations, including writes, token generation, event publishing, and engagement updates. These have different processing and I/O costs.
3. **Latency increases under mixed traffic.** Average latency increased from 4.46 ms to 30.29 ms.
4. **Phase 5 has a significant response-success problem.** Approximately 39.97% of requests returned non-2xx status codes. The individual endpoint responses must be inspected to identify the causes.
5. **The results are local benchmark results.** Both tests target `localhost`, so they do not establish production-scale capacity or global network performance.

## Recommended Next Steps

- Log HTTP status codes and error response bodies separately for each operation.
- Identify which of the four traffic categories generates the 12,982 non-2xx responses.
- Check application logs, Redis connectivity, database constraints, token validation, and request payloads.
- Rerun Phase 5 after fixing the identified issues.
- Monitor CPU, memory, Redis latency, database connection-pool utilization, and background-worker lag during the test.
- Repeat tests at different concurrency levels and run multiple trials to assess consistency.

**Conclusion:** Phase 4 demonstrates strong feed-read performance under a focused local workload. Phase 5 provides a more realistic mixed-workload test, but its current success rate indicates that further debugging and validation are necessary before claiming production readiness.
