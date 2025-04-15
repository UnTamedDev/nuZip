// zoho-helper.js
const axios = require('axios');
require('dotenv').config();

async function getAccessToken() {
  try {
    const response = await axios.post(process.env.ZOHO_TOKEN_URL, new URLSearchParams({
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    }));
    return response.data.access_token;
  } catch (error) {
    console.error('Error refreshing Zoho token:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { getAccessToken };