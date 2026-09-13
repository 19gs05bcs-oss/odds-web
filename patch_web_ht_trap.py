import subprocess

engine_file = subprocess.check_output(["find", ".", "-name", "goalEngine.ts"]).decode().strip().split("\n")[0]

with open(engine_file, "r") as f:
    code = f.read()

# Eski gevşek htVerdict bloğu
old_ht_verdict = """  let htVerdict = "BALANCED FIRST HALF (0-1 Goal Expectation)";
  if ((pOver25 < 0.48) && (medHtOu05 != null && medHtOu05 <= 1.42) && (medHt00 != null && medHt00 >= 2.60)) {
    htVerdict = "Early first-half strike (Zeledon: HT Over 0.5 / 1.5 live, then the match locks).";
  } else if (htVelocity === "HIGH_VELOCITY" || (medHtOu05 != null && medHtOu05 <= 1.30)) {
    htVerdict = "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 & 1.5 Over Potential)";
  } else if (htVelocity === "HARD_LOCK" || (isFalseOpen && (medHtOu05 == null || medHtOu05 >= 1.35))) {
    htVerdict = "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak)";
  }"""

# CLI ile birebir eşitlenen htVerdict bloğu (Statik tuzakta ilk yarı kilitlenir)
new_ht_verdict = """  let htVerdict = "BALANCED FIRST HALF (0-1 Goal Expectation)";
  const isStaticHtTrap = Boolean(
    (medHt00 != null && medHt00 >= 3.20) &&
    !isUnderLeaking &&
    (ou25UnderDrift <= 1.02)
  );

  if (isStaticHtTrap || scoreProfile === "STATIC_OVER_TRAP" || isFalseOpen) {
    htVerdict = "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak / Static Bait & Under Corridor)";
  } else if ((pOver25 < 0.48) && (medHtOu05 != null && medHtOu05 <= 1.42) && (medHt00 != null && medHt00 >= 2.60)) {
    htVerdict = "Early first-half strike (Zeledon: HT Over 0.5 / 1.5 live, then the match locks).";
  } else if ((htVelocity === "HIGH_VELOCITY" && isUnderLeaking) || (medHtOu05 != null && medHtOu05 <= 1.22 && isUnderLeaking)) {
    htVerdict = "🔥 FIRST HALF TEMPO / EARLY GOAL (High HT 0.5 & 1.5 Over Potential)";
  } else if (htVelocity === "HARD_LOCK") {
    htVerdict = "🔒 FIRST HALF HARD LOCK (0:0 Risk at Peak)";
  }"""

if old_ht_verdict in code:
    code = code.replace(old_ht_verdict, new_ht_verdict, 1)
    with open(engine_file, "w") as f:
        f.write(code)
    print(f"[+] {engine_file} ilk yarı karar bloğu CLI ile eşitlendi.")
else:
    print("[-] Blok bulunamadı, elle kontrol edin.")
