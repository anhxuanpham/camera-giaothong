export function isVercelRuntime(env = process.env) {
  return env.VERCEL === '1' || env.VERCEL === 'true';
}

export function parseHost(host) {
  const raw = String(host || '').trim().toLowerCase();
  if (!raw || /[/?#@\\\s]/.test(raw) || raw.includes('..')) return null;
  const match = raw.match(/^([a-z0-9.-]+)(?::(\d{1,5}))?$/);
  if (!match) return null;
  return {hostname: match[1], port: match[2] || ''};
}

export function vercelHostnames(env = process.env) {
  const hosts = new Set();
  for (const raw of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL, env.ALLOWED_HOST]) {
    if (!raw) continue;
    const hostname = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    if (hostname && /^[a-z0-9.-]+$/.test(hostname) && !hostname.includes('..')) hosts.add(hostname);
  }
  return hosts;
}

export function isAllowedHost(host, env = process.env) {
  const parsed = parseHost(host);
  if (!parsed) return false;
  if ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && parsed.port) return true;
  return isVercelRuntime(env) && vercelHostnames(env).has(parsed.hostname);
}

export function publicOrigin(host, env = process.env) {
  const parsed = parseHost(host);
  if (!parsed) return '';
  if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
    return parsed.port ? `http://${parsed.hostname}:${parsed.port}` : '';
  }
  if (isVercelRuntime(env) && vercelHostnames(env).has(parsed.hostname)) return `https://${parsed.hostname}`;
  return '';
}

export function isAllowedPublicOrigin(origin, env = process.env) {
  if (typeof origin !== 'string' || !origin) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (url.origin !== origin) return false;
  if (url.protocol === 'http:') {
    return (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && Boolean(url.port);
  }
  return url.protocol === 'https:' && !url.port && isVercelRuntime(env) &&
    vercelHostnames(env).has(url.hostname.toLowerCase());
}
