const crypto = require('crypto');

const BASE_URLS = {
  cn: 'https://openapi.tuyacn.com',
  us: 'https://openapi.tuyaus.com',
  'us-e': 'https://openapi-ueaz.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  'eu-w': 'https://openapi-weaz.tuyaeu.com',
  in: 'https://openapi.tuyain.com',
};

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

function hmacSha256Hex(secret, input) {
  return crypto.createHmac('sha256', secret).update(input, 'utf8').digest('hex').toUpperCase();
}

class TuyaCloudClient {
  constructor({ accessId, accessSecret, region = 'eu' }) {
    if (!accessId || !accessSecret) {
      throw new Error('Tuya Cloud API accessId/accessSecret are required');
    }
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.baseUrl = BASE_URLS[region];
    if (!this.baseUrl) {
      throw new Error(`Unknown Tuya region: ${region}`);
    }
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  _sign(method, path, body, accessToken) {
    const t = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    const contentHash = sha256Hex(bodyStr);
    const stringToSign = [method.toUpperCase(), contentHash, '', path].join('\n');
    const prefix = accessToken ? this.accessId + accessToken + t : this.accessId + t;
    const sign = hmacSha256Hex(this.accessSecret, prefix + stringToSign);
    return { t, sign };
  }

  async _rawRequest(method, path, body, accessToken) {
    const { t, sign } = this._sign(method, path, body, accessToken);
    const headers = {
      client_id: this.accessId,
      sign,
      t,
      sign_method: 'HMAC-SHA256',
      'Content-Type': 'application/json',
    };
    if (accessToken) {
      headers.access_token = accessToken;
    }

    const res = await fetch(this.baseUrl + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!json.success) {
      // Keep the numeric code on the error. Callers need to tell "the device is
      // offline" apart from "our credentials are wrong" - both arrive here as a
      // failed request, and the message alone is not worth branching on.
      const err = new Error(`Tuya API error ${json.code}: ${json.msg}`);
      err.tuyaCode = json.code;
      throw err;
    }
    return json.result;
  }

  async _ensureToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return this.token;
    }
    const result = await this._rawRequest('GET', '/v1.0/token?grant_type=1', null, null);
    this.token = result.access_token;
    this.tokenExpiresAt = Date.now() + (result.expire_time - 60) * 1000;
    return this.token;
  }

  async request(method, path, body) {
    const token = await this._ensureToken();
    return this._rawRequest(method, path, body, token);
  }
}

module.exports = { TuyaCloudClient };
