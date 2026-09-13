import subprocess

panel_file = subprocess.check_output(["find", "src", "-name", "GoalEnginePanel.tsx"]).decode().strip().split("\n")[0]
print(f"[*] Hedef dosya: {panel_file}")

with open(panel_file, "r") as f:
    code = f.read()

# Eksik label tanımlarını ekle
old_anchor = 'SOLO_HOLLOW_TRAP: "Solo Hollow Trap",'
if old_anchor in code and "ASYMMETRIC_CHOKE" not in code:
    new_labels = """SOLO_HOLLOW_TRAP: "Solo Hollow Trap",
  ASYMMETRIC_CHOKE: "Asymmetric Choke Trap",
  STATIC_RETAIL_BAIT: "Static Retail Bait","""
    code = code.replace(old_anchor, new_labels)

with open(panel_file, "w") as f:
    f.write(code)

print("[+] GoalEnginePanel.tsx etiketleri başarıyla güncellendi.")
