import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Server-only SDKs and native-ish deps stay external to the server bundle.
  serverExternalPackages: ["pino", "pg", "bullmq", "ioredis", "@aws-sdk/client-s3"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
