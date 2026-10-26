// Web transport pays a round trip per image. Send one bounded page, keeping PDF coordinates unchanged.
export function remotePagePlan(cssWidth, dpr, region) {
  const ratio=region.h/region.w;
  const width=Math.max(1,Math.round(Math.min(cssWidth*dpr,3200,5600/ratio)));
  const height=Math.max(1,Math.round(width*ratio));
  return {mode:'aligned',scale:width/region.w,bitmapW:width,bitmapH:height,cssW:cssWidth,cssH:cssWidth*ratio,key:`web${width}`};
}
