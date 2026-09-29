const fs = require('fs');
const axios = require('axios');

async function main() {
  const inputs = JSON.parse(fs.readFileSync(0, 'utf-8'));

  // Validate required inputs
  if (!inputs.afasBaseUrl) {
    console.log(JSON.stringify({
      success: false,
      error: "'afasBaseUrl' is required"
    }));
    process.exit(1);
  }
  if (!inputs.clientId) {
    console.log(JSON.stringify({
      success: false,
      error: "'clientId' is required"
    }));
    process.exit(1);
  }
  if (!inputs.clientSecret) {
    console.log(JSON.stringify({
      success: false,
      error: "'clientSecret' is required"
    }));
    process.exit(1);
  }
  if (!inputs.customerId && !inputs.subjectId) {
    console.log(JSON.stringify({
      success: false,
      error: "At least one of 'customerId' or 'subjectId' must be provided"
    }));
    process.exit(1);
  }

  // Authenticate with AFAS
  let accessToken;
  try {
    const authResponse = await axios.post(`${inputs.afasBaseUrl}/oauth/token`, {
      grant_type: 'client_credentials',
      client_id: inputs.clientId,
      client_secret: inputs.clientSecret
    });
    accessToken = authResponse.data.access_token;
  } catch (authError) {
    console.log(JSON.stringify({
      success: false,
      error: `Authentication failed: ${authError.message}`
    }));
    process.exit(1);
  }

  // Fetch customer data
  let customers = [];
  try {
    const customersResponse = await axios.get(`${inputs.afasBaseUrl}/api/v1/customers`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      params: {
        limit: inputs.limit,
        offset: inputs.offset,
        ...(inputs.customerId && { customerId: inputs.customerId }),
        ...(inputs.subjectId && { subjectId: inputs.subjectId })
      }
    });
    customers = customersResponse.data;
  } catch (customerError) {
    console.log(JSON.stringify({
      success: false,
      error: `Failed to fetch customer data: ${customerError.message}`
    }));
    process.exit(1);
  }

  // Fetch attachments if requested
  let attachments = [];
  if (inputs.includeAttachments) {
    try {
      const attachmentsResponse = await axios.get(`${inputs.afasBaseUrl}/api/v1/attachments`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        params: {
          ...(inputs.customerId && { customerId: inputs.customerId }),
          ...(inputs.subjectId && { subjectId: inputs.subjectId })
        }
      });
      attachments = attachmentsResponse.data;
    } catch (attachmentError) {
      console.log(JSON.stringify({
        success: false,
        error: `Failed to fetch attachments: ${attachmentError.message}`
      }));
      process.exit(1);
    }
  }

  // Output
  console.log(JSON.stringify({
    success: true,
    customers,
    attachments
  }));
}

main().catch(e => {
  console.log(JSON.stringify({
    success: false,
    error: e.message
  }));
  process.exit(1);
});