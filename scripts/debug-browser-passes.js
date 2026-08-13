async function run() {
  console.log("=== Pass 1: Direct fix on Desktop (1440x960) ===");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "./debug_pass1_direct_fix.png", scale: "css" });
  console.log("Saved ./debug_pass1_direct_fix.png");

  console.log("=== Pass 2: Interaction and Filter State ===");
  const firstChip = page.locator(".trends__chip").first();
  if (await firstChip.count() > 0) {
    const text = await firstChip.textContent();
    console.log(`Clicking first chip: ${text}`);
    await firstChip.click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: "./debug_pass2_interaction.png", scale: "css" });
    console.log("Saved ./debug_pass2_interaction.png");

    const clearBtn = page.locator(".feed__clear");
    if (await clearBtn.count() > 0) {
      await clearBtn.click();
      await page.waitForTimeout(600);
    }
  }

  console.log("=== Pass 3: Regression on Mobile (390x844) ===");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "./debug_pass3_mobile.png", scale: "css" });
  console.log("Saved ./debug_pass3_mobile.png");

  console.log("=== Pass 4: Holistic Settled Desktop Acceptance (1440x960) ===");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: "./debug_pass4_holistic.png", scale: "css" });
  console.log("Saved ./debug_pass4_holistic.png");

  console.log("All 4 browser passes completed successfully!");
}

await run();
