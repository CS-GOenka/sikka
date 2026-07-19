import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [{ source: "/", destination: "/transactions", permanent: false }];
  },
};

export default nextConfig;
