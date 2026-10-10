export function usesFluidShell(pathname: string) {
  return (
    pathname === '/app' ||
    pathname === '/app/voz' ||
    pathname === '/app/reddit' ||
    pathname === '/app/digest' ||
    /^\/app\/\d{8}$/.test(pathname) ||
    pathname.startsWith('/article') ||
    pathname.startsWith('/admin') ||
    pathname.startsWith('/sources')
  );
}
