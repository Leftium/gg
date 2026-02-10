/**
 * Word lists for generating deterministic human-readable callpoint names.
 * Used as a fallback in production when the gg-call-sites Vite plugin is not installed.
 *
 * Each list has exactly 256 entries (8-bit index) so a 32-bit hash cleanly maps to
 * an adjective-noun pair: adjectives[hash & 0xFF] + "-" + nouns[(hash >> 8) & 0xFF]
 * giving 65,536 unique combinations.
 *
 * Selection criteria:
 * - Short (3-6 chars) for compact console output
 * - Visually distinct (no near-homoglyphs like fast/last)
 * - Inoffensive
 */

// prettier-ignore
export const adjectives = [
	'able',   'acid',   'aged',   'airy',   'apt',    'avid',   'awry',   'balmy',
	'bare',   'beefy',  'bent',   'big',    'bland',  'bleak',  'blind',  'bliss',
	'blue',   'blunt',  'bold',   'brash',  'brave',  'brief',  'briny',  'brisk',
	'broad',  'buff',   'bulky',  'bumpy',  'burly',  'busy',   'calm',   'cheap',
	'chewy',  'chief',  'chilly', 'civil',  'clean',  'clear',  'close',  'cold',
	'cool',   'coral',  'cozy',   'crisp',  'cubic',  'curly',  'curvy',  'cute',
	'cyan',   'damp',   'dark',   'dear',   'deep',   'dense',  'dewy',   'dim',
	'dizzy',  'dopey',  'dorky',  'draft',  'dry',    'dual',   'dull',   'dusty',
	'eager',  'early',  'easy',   'edgy',   'elfin',  'elite',  'empty',  'equal',
	'even',   'every',  'evil',   'exact',  'extra',  'faded',  'fair',   'fancy',
	'fast',   'few',    'fine',   'firm',   'first',  'fishy',  'fit',    'five',
	'fixed',  'fizzy',  'flat',   'fleet',  'fluid',  'foggy',  'fond',   'four',
	'free',   'fresh',  'front',  'full',   'funky',  'funny',  'furry',  'fussy',
	'fuzzy',  'gaudy',  'giant',  'glad',   'gold',   'good',   'grand',  'gray',
	'great',  'green',  'grim',   'gross',  'grown',  'gusty',  'hairy',  'half',
	'happy',  'hard',   'hardy',  'harsh',  'hasty',  'hazy',   'hefty',  'high',
	'holy',   'honey',  'hot',    'huge',   'humid',  'husky',  'icy',    'ideal',
	'idle',   'inner',  'ionic',  'iron',   'ivory',  'jade',   'jazzy',  'jolly',
	'juicy',  'jumbo',  'jumpy',  'just',   'keen',   'kind',   'known',  'lanky',
	'large',  'last',   'late',   'lazy',   'lean',   'legal',  'light',  'limp',
	'live',   'local',  'lofty',  'lone',   'long',   'lost',   'loud',   'loved',
	'low',    'loyal',  'lucky',  'lumpy',  'lusty',  'mad',    'magic',  'main',
	'major',  'meek',   'merry',  'messy',  'mild',   'minty',  'misty',  'mixed',
	'moist',  'moody',  'mossy',  'muddy',  'murky',  'mushy',  'muted',  'naive',
	'neat',   'nerdy',  'new',    'next',   'nice',   'nimby',  'noble',  'noisy',
	'north',  'novel',  'numb',   'nutty',  'oaken',  'odd',    'oily',   'old',
	'olive',  'only',   'open',   'other',  'outer',  'oval',   'paid',   'pale',
	'pasty',  'perky',  'petty',  'pink',   'plain',  'plump',  'plush',  'polar',
	'poor',   'prime',  'proud',  'pulpy',  'pure',   'pushy',  'quick',  'quiet',
	'rare',   'raw',    'ready',  'real',   'rich',   'rigid',  'ripe',   'rosy',
	'rough',  'round',  'royal',  'ruby',   'rusty',  'safe',   'salty',  'same',
	'sandy',  'sharp',  'shiny',  'silky',  'slim',   'slow',   'small',  'snug',
] as const;

// prettier-ignore
export const nouns = [
	'ant',    'ape',    'asp',    'auk',    'bass',   'bat',    'bear',   'bee',
	'bird',   'bison',  'boar',   'bream',  'buck',   'bug',    'bull',   'bunny',
	'calf',   'carp',   'cat',    'chick',  'chimp',  'clam',   'cobra',  'cod',
	'colt',   'conch',  'coon',   'cow',    'crab',   'crane',  'crow',   'cub',
	'dart',   'deer',   'dingo',  'dodo',   'doe',    'dog',    'dove',   'drake',
	'drum',   'duck',   'eagle',  'eel',    'egret',  'elk',    'emu',    'ewe',
	'fawn',   'finch',  'fish',   'flea',   'fly',    'foal',   'fox',    'frog',
	'gator',  'gecko',  'goat',   'goose',  'grub',   'gull',   'guppy',  'hare',
	'hawk',   'hen',    'heron',  'hog',    'hornet', 'horse',  'hound',  'hyena',
	'ibex',   'ibis',   'iguana', 'imp',    'jackal', 'jay',    'joey',   'kite',
	'kiwi',   'koala',  'koi',    'lamb',   'lark',   'lemur',  'lion',   'llama',
	'lynx',   'macaw',  'mako',   'mare',   'mink',   'mite',   'mole',   'moose',
	'moth',   'mouse',  'mule',   'newt',   'okapi',  'orca',   'oryx',   'otter',
	'owl',    'ox',     'panda',  'parrot', 'perch',  'pig',    'pike',   'plover',
	'pony',   'prawn',  'pug',    'puma',   'quail',  'ram',    'rat',    'raven',
	'ray',    'robin',  'rook',   'roach',  'sail',   'seal',   'shad',   'shark',
	'sheep',  'shrew',  'shrimp', 'skate',  'skink',  'skua',   'skunk',  'sloth',
	'slug',   'smelt',  'snail',  'snake',  'snipe',  'sole',   'squid',  'stag',
	'stork',  'swan',   'swift',  'tapir',  'tern',   'thrush', 'toad',   'trout',
	'tuna',   'turkey', 'turtle', 'viper',  'vole',   'vulture','wasp',   'whale',
	'wolf',   'wombat', 'worm',   'wren',   'yak',    'zebra',  'adder',  'akita',
	'alpaca', 'anole',  'bongo',  'camel',  'civet',  'coati',  'coral',  'corgi',
	'dhole',  'drill',  'dugong', 'dunnit', 'eland',  'ermine', 'falcon', 'ferret',
	'gibbon', 'gopher', 'grouse', 'haddok', 'hermit', 'hippo',  'hoopoe', 'hutia',
	'impala', 'indri',  'isopod', 'jacana', 'jerboa', 'kakapo', 'kudu',   'loris',
	'magpie', 'marten', 'mayfly', 'merlin', 'murre',  'nandu',  'numbat', 'ocelot',
	'osprey', 'oyster', 'paca',   'pangol', 'pariah', 'peahen', 'pipit',  'pollock',
	'possum', 'potoo',  'python', 'quokka', 'rail',   'redfin', 'reebok', 'remora',
	'rhea',   'sable',  'saola',  'serval', 'siskin', 'snapper','snoek',  'sparrow',
	'spider', 'sponge', 'sprat',  'stoat',  'stilt',  'stint',  'sunbird','tanuki',
	'tarpon', 'tenrec', 'tigon',  'toucan', 'treefr', 'uguisu', 'urutu',  'vervet',
	'vizsla', 'walrus', 'weasel', 'weevil', 'whimbr', 'whydah', 'wisent', 'zorilla',
] as const;

/**
 * FNV-1a hash (32-bit). Fast, good distribution, zero dependencies.
 * Reference: http://www.isthe.com/chongo/tech/comp/fnv/
 */
export function fnv1a(str: string): number {
	let hash = 0x811c9dc5; // FNV offset basis
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193); // FNV prime
	}
	return hash >>> 0; // Ensure unsigned 32-bit
}

/**
 * Map a string to a deterministic adjective-noun pair.
 * Same input always produces the same word tuple.
 */
export function toWordTuple(str: string): string {
	const hash = fnv1a(str);
	const adj = adjectives[hash & 0xff];
	const noun = nouns[(hash >>> 8) & 0xff];
	return `${adj}-${noun}`;
}
