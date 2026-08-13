// Playwriter execution script to inspect the gbnews-watch UI
async function run() {
  console.log("Navigating to http://localhost:3000...");
  await page.goto("http://localhost:3000");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(2000);

  const title = await page.title();
  console.log("Document Title:", title);

  const headerStats = await page.evaluate(() => {
    return {
      title: document.querySelector(".masthead__title h1")?.textContent,
      status: document.querySelector(".status")?.textContent,
      mood: document.querySelector(".mood")?.textContent,
      meters: Array.from(document.querySelectorAll(".meter b")).map(b => b.textContent),
      onAir: document.querySelector(".onair")?.textContent,
      chips: Array.from(document.querySelectorAll(".trends__chip")).map(c => c.textContent.trim()),
      emoji: Array.from(document.querySelectorAll(".emoji-chip")).map(c => c.textContent.trim()),
      hasRoomCanvas: !!document.querySelector(".room__canvas"),
      commentsCount: document.querySelectorAll(".comment").length,
    };
  });
  console.log("Header & Feed Info:", JSON.stringify(headerStats, null, 2));

  // Take desktop screenshot
  await page.screenshot({ path: "./screenshot_desktop.png", scale: "css" });
  console.log("Desktop screenshot saved to ./screenshot_desktop.png");

  // If there are trending chips, click the first one
  const firstChip = page.locator(".trends__chip").first();
  if (await firstChip.count() > 0) {
    const chipText = await firstChip.textContent();
    console.log(`Clicking trending chip: ${chipText}`);
    await firstChip.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: "./screenshot_filtered.png", scale: "css" });
    console.log("Filtered screenshot saved to ./screenshot_filtered.png");

    // Clear filter
    const clearBtn = page.locator(".feed__clear");
    if (await clearBtn.count() > 0) {
      console.log("Clearing filter...");
      await clearBtn.click();
      await page.waitForTimeout(600);
    }
  }

  // Test mobile viewport
  console.log("Testing mobile viewport 390x844...");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "./screenshot_mobile.png", scale: "css" });
  console.log("Mobile screenshot saved to ./screenshot_mobile.png");

  // Reset to desktop viewport
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(600);

  console.log("Playwriter inspection complete!");
}

await run();
