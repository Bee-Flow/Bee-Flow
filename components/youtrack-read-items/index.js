const fs = require('fs');
const axios = require('axios');

async function main() {
  try {
    const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));
    const { youtrackUrl, apiToken, query, fields, max } = inputs;

    const apiUrl = `${youtrackUrl}/api/issues?query=${encodeURIComponent(query)}&fields=${encodeURIComponent(fields)}&max=${max}`;

    const response = await axios.get(apiUrl, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Accept': 'application/json'
      }
    });

    console.log(JSON.stringify({ items: response.data, success: true }));
  } catch (e) {
    let errorMessage = e.message;
    if (e.response && e.response.data) {
      errorMessage = JSON.stringify(e.response.data);
    } else if (e.response && e.response.status) {
      errorMessage = `Request failed with status code ${e.response.status}`;
    }
    console.log(JSON.stringify({ error: errorMessage, success: false }));
    process.exit(1);
  }
}

main();