export const WILAYAS: Record<number, string> = {
  1:  "Adrar",
  2:  "Chlef",
  3:  "Laghouat",
  4:  "Oum El Bouaghi",
  5:  "Batna",
  6:  "Béjaïa",
  7:  "Biskra",
  8:  "Béchar",
  9:  "Blida",
  10: "Bouira",
  11: "Tamanrasset",
  12: "Tébessa",
  13: "Tlemcen",
  14: "Tiaret",
  15: "Tizi Ouzou",
  16: "Alger",
  17: "Djelfa",
  18: "Jijel",
  19: "Sétif",
  20: "Saïda",
  21: "Skikda",
  22: "Sidi Bel Abbès",
  23: "Annaba",
  24: "Guelma",
  25: "Constantine",
  26: "Médéa",
  27: "Mostaganem",
  28: "M'Sila",
  29: "Mascara",
  30: "Ouargla",
  31: "Oran",
  32: "El Bayadh",
  33: "Illizi",
  34: "Bordj Bou Arreridj",
  35: "Boumerdès",
  36: "El Tarf",
  37: "Tindouf",
  38: "Tissemsilt",
  39: "El Oued",
  40: "Khenchela",
  41: "Souk Ahras",
  42: "Tipaza",
  43: "Mila",
  44: "Aïn Defla",
  45: "Naâma",
  46: "Aïn Témouchent",
  47: "Ghardaïa",
  48: "Relizane",
  49: "Timimoun",
  50: "Bordj Badji Mokhtar",
  51: "Ouled Djellal",
  52: "Béni Abbès",
  53: "In Salah",
  54: "In Guezzam",
  55: "Touggourt",
  56: "Djanet",
  57: "El Meghaier",
  58: "El Meniaa",
};


export const WILAYA_CODES = Object.keys(WILAYAS).map(Number).sort((a, b) => a - b);


export const WILAYA_BY_NAME: Record<string, number> = Object.fromEntries(
  Object.entries(WILAYAS).map(([code, name]) => [name, Number(code)])
);


export function wilayaName(code: number): string {
  const name = WILAYAS[code];
  if (!name) throw new Error(`Unknown wilaya code: ${code}`);
  return name;
}


export function isValidWilayaCode(code: number): boolean {
  return Number.isInteger(code) && code >= 1 && code <= 58 && code in WILAYAS;
}