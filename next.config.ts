import type { NextConfig } from "next";

// No redirects: "/" is the spending dashboard, and it is the app's default
// view. (It used to redirect to /transactions, back when the dashboard didn't
// exist and the transaction list was the whole app.)
const nextConfig: NextConfig = {};

export default nextConfig;
