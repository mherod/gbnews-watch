async function run() {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "./screenshot_desktop.png", scale: "css" });
  console.log("Quick snapshot saved to ./screenshot_desktop.png");
}

await run();
