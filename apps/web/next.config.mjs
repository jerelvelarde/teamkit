/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@copilotkit/teamkit-protocol", "@copilotkit/teamkit-client"],
  compress: false,
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  webpack(config) {
    config.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return config;
  },
};

export default nextConfig;
