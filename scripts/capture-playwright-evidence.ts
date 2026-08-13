import { chromium } from "playwright";

async function main() {
  console.log("Launching Chromium to capture Union Jack visual evidence...");
  const browser = await chromium.launch({ headless: true });
  
  // 1. Desktop 1440x960
  const contextDesktop = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: 2,
  });
  const pageDesktop = await contextDesktop.newPage();
  await pageDesktop.goto("http://localhost:3000/");
  await pageDesktop.waitForTimeout(1500);
  await pageDesktop.screenshot({ path: "./uj_desktop_view.png", scale: "css" });
  console.log("Captured ./uj_desktop_view.png");

  // 2. Mobile 390x844
  const contextMobile = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
  });
  const pageMobile = await contextMobile.newPage();
  await pageMobile.goto("http://localhost:3000/");
  await pageMobile.waitForTimeout(1500);
  await pageMobile.screenshot({ path: "./uj_mobile_view.png", scale: "css" });
  console.log("Captured ./uj_mobile_view.png");

  await browser.close();
  console.log("All visual evidence captured successfully!");
}

main().catch(console.error);
