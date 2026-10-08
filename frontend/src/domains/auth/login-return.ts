function localPath(value: unknown): string | null {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && !value.includes('\\') && !Array.from(value).some(character => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ? value : null;
}

export function loginReturnPath(queryPath: unknown, routeState: unknown): string {
  const requested = localPath(queryPath);
  if (requested) return requested;
  if (!routeState || typeof routeState !== 'object' || !('from' in routeState)) return '/';
  const from = routeState.from;
  if (!from || typeof from !== 'object' || !('pathname' in from)) return '/';
  const pathname = localPath(from.pathname);
  if (!pathname || pathname === '/login') return '/';
  const search = 'search' in from && typeof from.search === 'string' && from.search.startsWith('?') ? from.search : '';
  return localPath(pathname + search) || '/';
}
