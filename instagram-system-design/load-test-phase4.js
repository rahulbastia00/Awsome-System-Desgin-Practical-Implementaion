const autocannon = require('autocannon');

async function runPhase4Test() {
    console.log('🚀 Starting Phase 4 Load Test: Testing High-Concurrency Redis Feed Reads...');

    const instance = autocannon({
        url: 'http://localhost:3000/api/v1/feed?page=1&limit=10',
        connections: 50,
        duration: 20,
        method: 'GET',
        headers: {
            'x-user-id': '1' // Fetching Alice's pre-loaded Redis timeline feed
        }
    });

    autocannon.track(instance, { renderProgressBar: true });

    instance.on('done', (result) => {
        console.log('\n📊 Phase 4 Feed Load Test Completed!');
        console.log(`Requests/sec: ${result.requests.average}`);
        console.log(`Latency (avg): ${result.latency.average} ms`);
        console.log(`Successful 2xx responses: ${result['2xx']}`);
        console.log(`Errors / Timeouts: ${result.errors + result.timeouts}`);
    });
}

runPhase4Test();