const autocannon = require('autocannon');
const http = require('http');

// Helper to make an HTTP request for getting a pre-signed token
const getPresignedUrl = () => {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ filename: 'test.jpg', file_type: 'image/jpeg' });
        const req = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/v1/posts/presign-upload',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-user-id': '1',
                'Content-Length': data.length
            }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(JSON.parse(body)));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
};

async function runPhase2Test() {
    console.log('🚀 Step 1: Fetching a test pre-signed upload URL...');
    const presign = await getPresignedUrl();
    console.log('Got upload URL endpoint:', presign.upload_url);

    console.log('🚀 Step 2: Running Autocannon load test against Phase 2 endpoints...');

    // We test the metadata creation endpoint which now handles pure JSON lightweight payloads
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
            caption: 'Load testing lightweight JSON post creation!',
            media: [
                {
                    media_url: presign.media_url,
                    media_type: 'PHOTO'
                }
            ]
        })
    });

    autocannon.track(instance, { renderProgressBar: true });

    instance.on('done', (result) => {
        console.log('\n📊 Phase 2 Load Test Completed!');
        console.log(`Requests/sec: ${result.requests.average}`);
        console.log(`Latency (avg): ${result.latency.average} ms`);
        console.log(`Successful 2xx responses: ${result.non2xx ? result.requests - result.errors : result.requests}`); console.log(`Errors / Timeouts: ${result.errors + result.timeouts}`);
    });
}

runPhase2Test();