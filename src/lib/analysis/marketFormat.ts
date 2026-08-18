/** Saf market string yardımcıları — DB/postgres bağımlılığı YOK. */

/** market kolonu "TYPE:SCOPE" (ör. HOME_DRAW_AWAY:FULL_TIME) veya line'lı
 * marketlerde "TYPE:SCOPE:LINE" (ör. OVER_UNDER:FIRST_HALF:3.5) olarak
 * gelebilir. Sadece ilk ":"e göre bölersek line'lı marketlerde scope
 * "FIRST_HALF:3.5" gibi kirli çıkar ve hiçbir kolonla eşleşmez — bu yüzden
 * ikinci parçayı bilinen scope token'larına karşı doğruluyoruz. */
const KNOWN_SCOPES = new Set(["FULL_TIME", "FIRST_HALF", "SECOND_HALF"]);

export function splitMarket(market: string | null): { marketType: string; marketScope: string } {
  if (!market) return { marketType: "UNKNOWN", marketScope: "FULL_TIME" };
  const parts = market.split(":");
  if (parts.length === 1) return { marketType: parts[0], marketScope: "FULL_TIME" };
  if (KNOWN_SCOPES.has(parts[1])) {
    return { marketType: parts[0], marketScope: parts[1] };
  }
  // Bilinmeyen scope token'ı — eski davranışa düş (geriye dönük uyumluluk).
  return { marketType: parts[0], marketScope: parts.slice(1).join(":") };
}

