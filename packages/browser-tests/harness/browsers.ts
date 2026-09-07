import { chromium, firefox, webkit, type Browser, type BrowserType } from 'playwright-core';

export interface LaunchedBrowser {
  name: 'chromium' | 'firefox' | 'webkit';
  browser: Browser;
}

const TYPES: { name: LaunchedBrowser['name']; type: BrowserType }[] = [
  { name: 'chromium', type: chromium },
  { name: 'firefox', type: firefox },
  { name: 'webkit', type: webkit },
];

/**
 * Launch every browser the nix bundle can run here. A browser that fails to
 * launch is reported (not silently skipped) so the report is honest.
 */
export async function launchAll(): Promise<{
  launched: LaunchedBrowser[];
  failed: { name: string; error: string }[];
}> {
  const wanted = (process.env.BROWSERS ?? 'chromium,firefox,webkit').split(',');
  const launched: LaunchedBrowser[] = [];
  const failed: { name: string; error: string }[] = [];
  for (const t of TYPES) {
    if (!wanted.includes(t.name)) continue;
    try {
      const browser = await t.type.launch({ headless: true });
      launched.push({ name: t.name, browser });
    } catch (e) {
      failed.push({ name: t.name, error: String((e as Error).message ?? e).split('\n')[0] });
    }
  }
  return { launched, failed };
}
