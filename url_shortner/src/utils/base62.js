const crypto = require('crypto');

const BASE62_CHARS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';


function generateShortCode(length = 7) {
    const bytes = crypto.randomBytes(length);
    let code = '';
    for (let i = 0; i < length; i++) {
        code += BASE62_CHARS[bytes[i] % BASE62_CHARS.length];
    }
    return code;
}

module.exports = {
    generateShortCode,
};
