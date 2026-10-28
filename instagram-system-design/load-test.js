const autocannon = require('autocannon');
const FormData = require('form-data');

// Create a dummy 1MB image buffer to simulate a photo upload
const dummyImageBuffer = Buffer.alloc(1024 * 1024, 'a'); // 1MB of 'a's

// Function to generate a fresh multipart/form-data payload for every request
const generatePayload = () => {
    const form = new FormData();
    form.append('caption', 'Stress testing Phase 1 server load!');
    form.append('media', dummyImageBuffer, {
        filename: 'test-image.jpg',
        contentType: 'image/jpeg',
    });

    return {
        buffer: form.getBuffer(),
        headers: form.getHeaders(),
    };
};

async function runLoadTest() {
    console.log('🚀 Starting Phase 1 Load Test: Simulating heavy multipart uploads...');

    const { buffer, headers } = generatePayload();

    const instance = autocannon({
        url: 'http://localhost:3000/api/v1/posts',
        connections: 50,    // Number of concurrent connections
        duration: 20,       // Duration of test in seconds
        method: 'POST',
        headers: headers,
        body: buffer,
    });

    // Print real-time progress to console
    autocannon.track(instance, { renderProgressBar: true });

    instance.on('done', (result) => {
        console.log('\n📊 Load Test Completed!');
        console.log(`Requests/sec: ${result.requests.average}`);
        console.log(`Latency (avg): ${result.latency.average} ms`);
        console.log(`Errors / Timeouts: ${result.errors + result.timeouts}`);
    });
}

runLoadTest();