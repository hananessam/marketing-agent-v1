/** Countries an ad can be shown in, as [code, name]. */
export const COUNTRIES: [string, string][] = [
  ["US", "United States"], ["GB", "United Kingdom"], ["CA", "Canada"], ["AU", "Australia"], ["NZ", "New Zealand"], ["IE", "Ireland"],
  ["DE", "Germany"], ["FR", "France"], ["ES", "Spain"], ["IT", "Italy"], ["NL", "Netherlands"], ["SE", "Sweden"], ["NO", "Norway"], ["DK", "Denmark"],
  ["FI", "Finland"], ["CH", "Switzerland"], ["AT", "Austria"], ["BE", "Belgium"], ["PT", "Portugal"], ["PL", "Poland"],
  ["BR", "Brazil"], ["MX", "Mexico"], ["AR", "Argentina"], ["CL", "Chile"], ["CO", "Colombia"],
  ["IN", "India"], ["SG", "Singapore"], ["AE", "United Arab Emirates"], ["SA", "Saudi Arabia"], ["EG", "Egypt"], ["ZA", "South Africa"], ["NG", "Nigeria"], ["KE", "Kenya"], ["JP", "Japan"], ["KR", "South Korea"],
];

export const countryName = (code: string) => COUNTRIES.find(([c]) => c === code)?.[1] ?? code;
