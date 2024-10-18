/** @type {import('next').NextConfig} */
module.exports = {
  output: 'export',
  trailingSlash: true,
  poweredByHeader: false,
  experimental: {
    instrumentationHook: true
  }
};
