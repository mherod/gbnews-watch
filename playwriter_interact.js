// Playwriter script to test interactive filter and capture detailed view
async function run() {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("http://localhost:3000");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(1500);

  // Hover over a node in the Room canvas if possible or click a trending chip
  const chips = page.locator(".trends__chip");
  if (await chips.count() > 0) {
    const targetChip = chips.first();
    const text = await targetChip.textContent();
    console.log("Clicking chip:", text);
    await targetChip.click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: "./screenshot_filtered.png", scale: "css" });
    console.log("Saved screenshot_filtered.png");
  }

  // Scroll down feed to see comments
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "./screenshot_feed.png", scale: "css" });
  console.log("Saved screenshot_feed.png");
}

await run();
