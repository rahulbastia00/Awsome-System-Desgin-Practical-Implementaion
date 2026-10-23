function isValidUrl(urlString) {
    if (!urlString || typeof urlString !== 'string') {
        return false
    }

    try {
        const parsed = new URL(urlString);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch (err) {
        return false;
    }
}

module.exports = {
    isValidUrl,
}