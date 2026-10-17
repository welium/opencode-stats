/**
 * Static asset resolution for the built client in `dist/client`.
 *
 * Plan references: §5 "Serve only built assets inside the static root. Validate
 * decoded paths and real paths, reject escaping symlinks/traversal, and never
 * expose the project or source directories. SPA fallback applies only to valid
 * non-API navigation." and "Missing built assets should produce a clear local
 * build instruction while health/API remain usable."
 */

import { realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

export interface StaticRequest {
  /** Percent-encoded pathname from the request target (no query string). */
  pathname: string;
  /** True for browser-style navigation (HTML or no explicit Accept header). */
  acceptsHtml: boolean;
}

export interface StaticAsset {
  /** Real (symlink-resolved) path of a regular file inside the static root. */
  filePath: string;
  /** True for content-hashed build output, which may be cached indefinitely. */
  immutable: boolean;
  /** False for HTML entry documents, which must revalidate. */
  cacheable: boolean;
}

export type StaticResolution =
  | ({ kind: 'asset' } & StaticAsset)
  | { kind: 'missing-build' }
  | { kind: 'not-found' }
  | { kind: 'bad-request'; reason: string };

/** `dist/client` build output is the only static root. */
export function defaultStaticRoot(projectRoot: string): string {
  return resolve(projectRoot, 'dist', 'client');
}

export const MISSING_BUILD_INSTRUCTION =
  'The dashboard client has not been built. Run "npm run build" in the project directory, then reload this page.';

const IMMUTABLE_PREFIX = 'assets';

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

function isContained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** A path with a file extension is not treated as SPA navigation. */
function hasFileExtension(relativePath: string): boolean {
  const last = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return extname(last) !== '';
}

function isNavigationRequest(request: StaticRequest, relativePath: string): boolean {
  return request.acceptsHtml && !hasFileExtension(relativePath);
}

/**
 * Resolve a regular file inside `realRoot`.
 *
 * The candidate is rejected when its real (symlink-resolved) path leaves the
 * real static root, so escaped symlinks cannot expose files outside the build
 * output. Directories are not servable, so no listing is ever produced.
 */
async function resolveFileInside(candidate: string, realRoot: string): Promise<StaticAsset | null> {
  if (!isContained(realRoot, candidate)) return null;

  let resolvedPath: string;
  try {
    resolvedPath = await realpath(candidate);
  } catch {
    return null;
  }
  if (!isContained(realRoot, resolvedPath)) return null;

  let stats: Awaited<ReturnType<typeof stat>>;
  try {
    stats = await stat(resolvedPath);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;

  const relative = resolvedPath.slice(realRoot.length).replace(/^\/+/, '');
  const isHtml = extname(resolvedPath).toLowerCase() === '.html';
  return {
    filePath: resolvedPath,
    immutable: !isHtml && relative.split('/')[0] === IMMUTABLE_PREFIX,
    cacheable: !isHtml,
  };
}

/**
 * Resolve a request pathname to a built asset, the SPA entry document, or an
 * explicit failure that the HTTP layer turns into a safe response.
 */
export async function resolveStaticRequest(request: StaticRequest, staticRoot: string): Promise<StaticResolution> {
  const decoded = decodePathname(request.pathname);
  if (decoded === null) return { kind: 'bad-request', reason: 'path is not valid percent-encoding' };
  if (decoded.includes('\0')) return { kind: 'bad-request', reason: 'path contains a null byte' };

  const relativePath = decoded.replace(/^\/+/, '');
  const relativeSegments = relativePath === '' ? [] : relativePath.split('/');
  if (relativeSegments.some((segment) => segment === '..')) return { kind: 'not-found' };

  let staticRootRealPath: string;
  try {
    staticRootRealPath = await realpath(staticRoot);
  } catch {
    // No build output at all: report a build instruction instead of a 404.
    return { kind: 'missing-build' };
  }

  const serveIndex = async (): Promise<StaticResolution> => {
    const index = await resolveFileInside(resolve(staticRootRealPath, 'index.html'), staticRootRealPath);
    return index === null ? { kind: 'missing-build' } : { kind: 'asset', ...index };
  };

  // Only the root document is served directly; every other path is a file lookup
  // followed by an SPA fallback for valid navigation.
  if (relativePath === '') return serveIndex();

  const candidate = resolve(staticRootRealPath, ...relativeSegments);
  const asset = await resolveFileInside(candidate, staticRootRealPath);
  if (asset !== null) return { kind: 'asset', ...asset };

  return isNavigationRequest(request, relativePath) ? serveIndex() : { kind: 'not-found' };
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/** True when the request looks like browser navigation rather than an asset fetch. */
export function acceptsHtmlNavigation(acceptHeader: string | undefined): boolean {
  if (acceptHeader === undefined || acceptHeader === '') return true;
  return acceptHeader.includes('text/html') || acceptHeader.includes('*/*');
}
