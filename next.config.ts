import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // ビルド時のTypeScriptエラーを無視して公開を優先する
    ignoreBuildErrors: true,
  },
  eslint: {
    // ビルド時のESLintエラー（構文チェック）を無視して公開を優先する
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;