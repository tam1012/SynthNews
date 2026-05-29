export function usesFluidShell(pathname: string) {
  return (
    pathname === '/' ||
    pathname === '/voz' ||
    pathname === '/reddit' ||
    pathname === '/digest' ||
    /^\/\d{8}$/.test(pathname) ||
    pathname.startsWith('/article') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/sources')
  );
}
