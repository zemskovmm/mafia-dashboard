import {
  UserRound,
  Smile,
  VenetianMask,
  HatGlasses,
  Star,
  Shield,
  Crown,
  Heart,
  Spade,
  Diamond,
  Club,
  Cat,
  Dog,
  Bird,
  Fish,
  Rabbit,
  Squirrel,
  Flame,
  Moon,
  Sun,
  type LucideIcon,
} from "lucide-react";
import type { BuiltinRoleIconId } from "../../api/player-role-icon-contracts.js";
import type { Locale } from "../../i18n/I18nProvider.js";

export const ROLE_ICON_CATEGORIES = ["people", "animals", "symbols"] as const;
export type RoleIconCategory = (typeof ROLE_ICON_CATEGORIES)[number];
interface RoleIconEntry {
  readonly id: BuiltinRoleIconId;
  readonly Icon: LucideIcon;
  readonly category: RoleIconCategory;
  readonly names: Readonly<Record<Locale, string>>;
}

// Curated, static Lucide imports (ISC). No runtime lookup, CDN or remote artwork.
export const ROLE_ICON_LIBRARY: readonly RoleIconEntry[] = [
  { id: "user", Icon: UserRound, category: "people", names: { en: "Person", ru: "Человек" } },
  { id: "smile", Icon: Smile, category: "people", names: { en: "Smile", ru: "Улыбка" } },
  {
    id: "venetian-mask",
    Icon: VenetianMask,
    category: "people",
    names: { en: "Mask", ru: "Маска" },
  },
  {
    id: "hat-glasses",
    Icon: HatGlasses,
    category: "people",
    names: { en: "Hat and glasses", ru: "Шляпа и очки" },
  },
  { id: "star", Icon: Star, category: "symbols", names: { en: "Star", ru: "Звезда" } },
  { id: "shield", Icon: Shield, category: "symbols", names: { en: "Shield", ru: "Щит" } },
  { id: "crown", Icon: Crown, category: "symbols", names: { en: "Crown", ru: "Корона" } },
  { id: "heart", Icon: Heart, category: "symbols", names: { en: "Heart", ru: "Сердце" } },
  { id: "spade", Icon: Spade, category: "symbols", names: { en: "Spade", ru: "Пики" } },
  { id: "diamond", Icon: Diamond, category: "symbols", names: { en: "Diamond", ru: "Бубны" } },
  { id: "club", Icon: Club, category: "symbols", names: { en: "Club", ru: "Трефы" } },
  { id: "cat", Icon: Cat, category: "animals", names: { en: "Cat", ru: "Кошка" } },
  { id: "dog", Icon: Dog, category: "animals", names: { en: "Dog", ru: "Собака" } },
  { id: "bird", Icon: Bird, category: "animals", names: { en: "Bird", ru: "Птица" } },
  { id: "fish", Icon: Fish, category: "animals", names: { en: "Fish", ru: "Рыба" } },
  { id: "rabbit", Icon: Rabbit, category: "animals", names: { en: "Rabbit", ru: "Кролик" } },
  { id: "squirrel", Icon: Squirrel, category: "animals", names: { en: "Squirrel", ru: "Белка" } },
  { id: "flame", Icon: Flame, category: "symbols", names: { en: "Flame", ru: "Огонь" } },
  { id: "moon", Icon: Moon, category: "symbols", names: { en: "Moon", ru: "Луна" } },
  { id: "sun", Icon: Sun, category: "symbols", names: { en: "Sun", ru: "Солнце" } },
];

const categoryNames: Record<RoleIconCategory, Record<Locale, string>> = {
  people: { en: "People and masks", ru: "Люди и маски" },
  animals: { en: "Animals", ru: "Животные" },
  symbols: { en: "Symbols", ru: "Символы" },
};
export const roleIconCategoryName = (category: RoleIconCategory, locale: Locale): string =>
  categoryNames[category][locale];
export const findRoleIcon = (id: string) => ROLE_ICON_LIBRARY.find((entry) => entry.id === id);
export const searchRoleIcons = (query: string, category: RoleIconCategory | "all" = "all") => {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return ROLE_ICON_LIBRARY.filter((entry) => {
    const haystack = [
      entry.id,
      ...Object.values(entry.names),
      ...Object.values(categoryNames[entry.category]),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return (
      (category === "all" || category === entry.category) &&
      terms.every((term) => haystack.includes(term))
    );
  });
};
