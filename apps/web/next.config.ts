import type { NextConfig } from 'next';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // Docker 镜像用 standalone 输出：只打包真正用到的依赖，
  // 最终镜像里不含源码和 devDependencies
  output: 'standalone',
  // monorepo 里要显式指到仓库根，否则 standalone 会漏掉提升到根 node_modules 的包
  outputFileTracingRoot: path.join(here, '../../'),
  reactStrictMode: true,
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    // 本地开发时把 /api 转发给后端。生产环境由 Caddy 分流，这段不生效。
    const target = process.env.API_INTERNAL_URL || 'http://127.0.0.1:3010';
    return [{ source: '/api/:path*', destination: `${target}/api/:path*` }];
  },
};

export default config;
