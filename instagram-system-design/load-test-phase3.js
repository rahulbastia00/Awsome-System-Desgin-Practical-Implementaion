const autocannon = require('autocannon');

async function runPhase3Test() {
    console.log('🚀 Starting Phase 3 Load Test: Testing Async Event Queuing under Load...');

    const instance = autocannon({
        url: 'http://localhost:3000/api/v1/posts',
        connections: 50,
        duration: 20,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-user-id': '1'
        },
        body: JSON.stringify({
            caption: 'Load testing Redis Streams async decoupling!',
            media: [
                {
                    media_url: '/uploads/dummy-test.jpg',
                    media_type: 'PHOTO'
                }
            ]
        })
    });

    autocannon.track(instance, { renderProgressBar: true });

    instance.on('done', (result) => {
        console.log('\n📊 Phase 3 Load Test Completed!');
        console.log(`Requests/sec: ${result.requests.average}`);
        console.log(`Latency (avg): ${result.latency.average} ms`);
        console.log(`Errors / Timeouts: ${result.errors + result.timeouts}`);
    });
}

runPhase3Test();