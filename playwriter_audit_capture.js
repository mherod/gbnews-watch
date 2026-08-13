// Playwriter script to capture comprehensive audit screenshots
async function run() {
  console.log("Setting desktop viewport 1440x960...");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("http://localhost:3000");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  // 1. Desktop Main (Header + Taproom map)
  await page.screenshot({ path: "./audit_desktop_main.png", scale: "css" });
  console.log("Saved ./audit_desktop_main.png");

  // 2. Desktop Feed (Scrolled down)
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(600);
  await page.screenshot({ path: "./audit_desktop_feed.png", scale: "css" });
  console.log("Saved ./audit_desktop_feed.png");

  // 3. Desktop Filtered
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(400);
  const firstChip = page.locator(".trends__chip").first();
  if (await firstChip.count() > 0) {
    await firstChip.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: "./audit_desktop_filtered.png", scale: "css" });
    console.log("Saved ./audit_desktop_filtered.png");
    // Clear filter
    const clearBtn = page.locator(".feed__clear");
    if (await clearBtn.count() > 0) await clearBtn.click();
    await page.waitForTimeout(400);
  }

  // 4. Tablet View (768x1024)
  console.log("Setting tablet viewport 768x1024...");
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "./audit_tablet.png", scale: "css" });
  console.log("Saved ./audit_tablet.png");

  // 5. Mobile View (390x844)
  console.log("Setting mobile viewport 390x844...");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: "./audit_mobile.png", scale: "css" });
  console.log("Saved ./audit_mobile.png");

  // Reset to desktop
  await page.setViewportSize({ width: 1440, height: 960 });
  console.log("Audit screenshots capture complete!");
}

await run();
