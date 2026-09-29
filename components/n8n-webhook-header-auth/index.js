const axios = require('axios');

let inputData = '';
process.stdin.on('data', chunk => inputData += chunk);

process.stdin.on('end', async () => {
    try {
        const inputs = JSON.parse(inputData);

        // Validation
        if (!inputs.webhookUrl) throw new Error('Webhook URL is required');
        if (!inputs.headerName) throw new Error('Header Name is required');
        if (!inputs.headerValue) throw new Error('Header Value is required');

        // Construct headers dynamically
        const headers = {
            'Content-Type': 'application/json'
        };
        // Add the custom auth header
        headers[inputs.headerName] = inputs.headerValue;

        // Send Request
        const response = await axios.post(inputs.webhookUrl, inputs.data || {}, {
            headers: headers
        });

        // Output Result
        const result = {
            response: response.data,
            status: response.status,
            success: true
        };

        console.log(JSON.stringify(result));

    } catch (e) {
        // Handle Axios errors nicely
        if (e.response) {
            process.stderr.write(`n8n Error (${e.response.status}): ${JSON.stringify(e.response.data)}`);
        } else {
            process.stderr.write(e.message);
        }
        process.exit(1);
    }
});