// Deterministic synthetic seed data. No randomness: every value derives from the index.
// Company names are coined words, websites use the reserved ".example" TLD (RFC 2606), and contacts get
// no email/linkedin: those are produced (and labelled synthetic) by the enrichment provider.

export const COMPANY_COUNT = 60;
export const CONTACTS_PER_COMPANY = 4;

export interface SeedCompany {
  id: string;
  name: string;
  website: string;
  industry: string;
  employees: number;
  country: string;
  description: string;
}

export interface SeedContact {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  fullName: string;
  jobTitle: string;
}

const PREFIXES = ["Veltrix", "Quillon", "Marnova", "Tessara", "Brindle", "Orvana", "Halcyra", "Zentora", "Lumivar", "Norvique", "Caldwyn", "Ostrava"];
const SUFFIXES = ["Labs", "Systems", "Analytics", "Works", "Group"];

// 3 of 12 slots are AI, so 15 of 60 companies are in the "Artificial Intelligence" industry.
const INDUSTRIES = [
  "Artificial Intelligence", "Software", "Fintech", "Healthcare",
  "Artificial Intelligence", "Logistics", "Cybersecurity", "Retail",
  "Artificial Intelligence", "Energy", "Education", "Manufacturing",
];

const COUNTRIES = [
  "Australia", "Australia", "New Zealand", "United States", "Australia",
  "United Kingdom", "Singapore", "India", "Canada", "Australia",
];

const OFFERINGS: Record<string, string[]> = {
  "Artificial Intelligence": [
    "AI assistants that automate enterprise customer support",
    "applied AI for computer vision in industrial inspection",
    "AI-driven forecasting and document processing models",
  ],
  Software: [
    "cloud developer platforms with AI-assisted code review",
    "workflow automation software for operations teams",
    "data integration tooling for analytics teams",
  ],
  Fintech: ["payments infrastructure for small businesses", "credit risk scoring for lenders", "treasury and invoicing software"],
  Healthcare: ["clinic scheduling and patient engagement software", "diagnostic imaging workflow tools", "remote patient monitoring devices"],
  Logistics: ["freight routing and fleet tracking", "warehouse automation systems", "last-mile delivery coordination"],
  Cybersecurity: ["endpoint threat detection", "identity and access governance", "security awareness training"],
  Retail: ["inventory planning for retailers", "loyalty and personalisation platforms", "point-of-sale systems"],
  Energy: ["grid analytics and demand forecasting", "solar asset management", "battery storage optimisation"],
  Education: ["adaptive learning platforms", "student progress analytics", "online course authoring tools"],
  Manufacturing: ["predictive maintenance sensors", "supply chain planning", "quality inspection automation"],
};

const SIZES = [18, 45, 75, 120, 180, 260, 400, 650, 1200, 2800, 6500, 12000];

const EXECUTIVE = ["Chief Executive Officer", "Chief Technology Officer", "Chief Operating Officer", "Founder and CEO"];
const ENGINEERING = [
  "VP Engineering", "Engineering Manager", "Staff Engineer", "Senior Engineer",
  "Software Engineer", "Head of Data", "Machine Learning Engineer", "Data Engineer",
];
const PRODUCT = ["Product Manager", "Head of Product", "Design Lead", "Technical Program Manager"];
const COMMERCIAL = ["Head of Sales", "Account Executive", "Marketing Manager", "Customer Success Manager", "Operations Manager", "Finance Manager"];

const FIRST_NAMES = [
  "Aiden", "Priya", "Mateo", "Chloe", "Kenji", "Fatima", "Liam", "Sofia", "Arjun", "Hannah",
  "Noah", "Mei", "Omar", "Isla", "Lucas", "Anika", "Tane", "Grace", "Ravi", "Elena",
  "Jack", "Yuki", "Zara", "Daniel", "Amara", "Ben", "Leila", "Oscar", "Nia", "Hugo",
];
const LAST_NAMES = [
  "Nguyen", "Patel", "Okafor", "Smith", "Tanaka", "Haddad", "Murphy", "Rossi", "Singh", "Kowalski",
  "Chen", "Fischer", "Nakamura", "Williams", "Moreau", "Kaur", "Ward", "Alvarez", "Sato", "Brown",
  "Ivanov", "Lim", "Campbell", "Mendes", "Khan", "Larsen", "Reyes", "Thompson", "Das", "Wright",
];

const at = <T>(items: readonly T[], index: number): T => items[index % items.length] as T;

export function buildCompanies(): SeedCompany[] {
  return Array.from({ length: COMPANY_COUNT }, (_, i) => {
    const name = `${at(PREFIXES, i)} ${at(SUFFIXES, Math.floor(i / PREFIXES.length))}`;
    const industry = at(INDUSTRIES, i);
    const country = at(COUNTRIES, i);
    const offering = at(OFFERINGS[industry] ?? [], Math.floor(i / 12));
    return {
      id: `cmp_${i + 1}`,
      name,
      website: `https://${name.toLowerCase().replace(/\s+/g, "")}.example`,
      industry,
      employees: at(SIZES, i * 5 + 2) + ((i * 7) % 23),
      country,
      description: `${name} builds ${offering}. Based in ${country}.`,
    };
  });
}

export function buildContacts(): SeedContact[] {
  const contacts: SeedContact[] = [];
  for (let c = 0; c < COMPANY_COUNT; c++) {
    for (let k = 0; k < CONTACTS_PER_COMPANY; k++) {
      const j = c * CONTACTS_PER_COMPANY + k;
      const firstName = at(FIRST_NAMES, j);
      // (7r + 3m) mod 30 is distinct for the 8 values of m, so all 240 full names are unique.
      const lastName = at(LAST_NAMES, 7 * (j % 30) + 3 * Math.floor(j / 30));
      const pools = [EXECUTIVE, ENGINEERING, PRODUCT, COMMERCIAL];
      const jobTitle = at(pools[k] ?? COMMERCIAL, k === 0 ? c : c * 5 + k);
      contacts.push({
        id: `cnt_${j + 1}`,
        companyId: `cmp_${c + 1}`,
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`,
        jobTitle,
      });
    }
  }
  return contacts;
}
