/**
 * Debug probe to verify official Union Jack colors, palette variables, and live server state.
 */
const officialSpecs = {
  royalBlue: "#012169",
  red: "#C8102E",
  white: "#FFFFFF",
  pantoneBlue: "280 C",
  pantoneRed: "186 C",
};

console.log("--- step 1: Official Union Jack Specification ---");
console.dir(officialSpecs, { depth: null });

console.log("--- step 2: Checking web/app.css palette tokens ---");
const cssContent = await Bun.file("web/app.css").text();
const hasPantoneBlue = cssContent.includes("#012169") || cssContent.includes("#00247d");
const hasPantoneRed = cssContent.includes("#c8102e") || cssContent.includes("#cf142b");
console.log("app.css has official blue:", hasPantoneBlue);
console.log("app.css has official red:", hasPantoneRed);

console.log("--- step 3: Health check on http://localhost:3000 ---");
try {
  const res = await fetch("http://localhost:3000/api/schedule");
  console.log("schedule endpoint status:", res.status);
  const data = await res.json();
  console.log("schedule payload shape:", typeof data, "has onAir:", !!data.onAir);
} catch (err) {
  console.error("fetch failed:", err);
}

console.log("--- debug probe complete ---");
