export type CreatureId = 'dragon'|'bee'|'fox'|'hare'|'elephant'|'owl'|'seal'|'goat'|'marmot'|'squirrel'|'ankylosaurus'|'carnotaurus'|'oviraptor'|'pachycephalosaurus'|'plesiosaurus'|'pterodactylus'|'spinosaurus'|'stegosaurus'|'trex'|'triceratops'|'eagle'|'flamingo'|'hummingbird'|'kiwi'|'macaw'|'peacock'|'pelican'|'penguin'|'rooster'|'toucan'
export type CreatureBehavior = 'dragon'|'bee'|'hop'|'stomp'|'fly'|'swim'|'waddle'|'strut'|'sneak'|'amble'|'peck'
type Creature = { id: CreatureId; name: string; icon: string; greeting: string; behavior: CreatureBehavior; moves: [string,string,string] }

// Models are bundled locally. The profile downloads only the selected GLB.
export const PROFILE_CREATURES: Creature[] = [
 {id:'dragon',name:'Ashwing Dragon',icon:'🐉',greeting:'A tiny dragon says hello!',behavior:'dragon',moves:['Flying-loop','Walk-loop','Idle-loop']},
 {id:'bee',name:'Bumble Bee',icon:'🐝',greeting:'Bzzzt! So happy to see you!',behavior:'bee',moves:['attack','walk','idle']},
 {id:'fox',name:'Fox',icon:'🦊',greeting:'A clever little hello from Fox!',behavior:'sneak',moves:['walk','attack','idle']},
 {id:'hare',name:'Hare',icon:'🐇',greeting:'Hop hop! Welcome to my burrow!',behavior:'hop',moves:['attack','walk','idle']},
 {id:'elephant',name:'Elephant',icon:'🐘',greeting:'A big, gentle hello!',behavior:'amble',moves:['attack','walk','idle']},
 {id:'owl',name:'Owl',icon:'🦉',greeting:'Hoo is visiting? You are!',behavior:'peck',moves:['attack','walk','idle']},
 {id:'seal',name:'Seal',icon:'🦭',greeting:'A splashy hello from Seal!',behavior:'swim',moves:['attack','idle','walk']},
 {id:'goat',name:'Goat',icon:'🐐',greeting:'Hey there, mountain friend!',behavior:'amble',moves:['attack','walk','idle']},
 {id:'marmot',name:'Marmot',icon:'🐿️',greeting:'Peekaboo! Glad you stopped by!',behavior:'amble',moves:['attack','idle','walk']},
 {id:'squirrel',name:'Squirrel',icon:'🐿️',greeting:'Welcome! I saved you an acorn!',behavior:'sneak',moves:['walk','attack','idle']},
 {id:'ankylosaurus',name:'Ankylosaurus',icon:'🦕',greeting:'Tiny tail club, giant hello!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'carnotaurus',name:'Carnotaurus',icon:'🦖',greeting:'A friendly dino roar for you!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'oviraptor',name:'Oviraptor',icon:'🦖',greeting:'Dino-sized welcome!',behavior:'hop',moves:['attack','walk','idle']},
 {id:'pachycephalosaurus',name:'Pachycephalosaurus',icon:'🦕',greeting:'Bonk! Just saying hello!',behavior:'stomp',moves:['attack','idle','walk']},
 {id:'plesiosaurus',name:'Plesiosaurus',icon:'🦕',greeting:'A wave from the ancient seas!',behavior:'swim',moves:['walk','attack','idle']},
 {id:'pterodactylus',name:'Pterodactyl',icon:'🪽',greeting:'Flying in to say hello!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'spinosaurus',name:'Spinosaurus',icon:'🦖',greeting:'A fin-tastic hello!',behavior:'stomp',moves:['walk','attack','idle']},
 {id:'stegosaurus',name:'Stegosaurus',icon:'🦕',greeting:'Plates up! Welcome, friend!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'trex',name:'T-Rex',icon:'🦖',greeting:'The tiniest mighty roar for you!',behavior:'stomp',moves:['attack','walk','idle']},
 {id:'triceratops',name:'Triceratops',icon:'🦕',greeting:'Three cheers for your visit!',behavior:'stomp',moves:['walk','attack','idle']},
 {id:'eagle',name:'Eagle',icon:'🦅',greeting:'A soaring hello!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'flamingo',name:'Flamingo',icon:'🦩',greeting:'One-legged welcome dance!',behavior:'strut',moves:['walk','attack','idle']},
 {id:'hummingbird',name:'Hummingbird',icon:'🐦',greeting:'A quick little hello!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'kiwi',name:'Kiwi Bird',icon:'🐤',greeting:'A shy hello from Kiwi!',behavior:'peck',moves:['walk','attack','idle']},
 {id:'macaw',name:'Macaw',icon:'🦜',greeting:'Hello, gorgeous human!',behavior:'fly',moves:['attack','walk','idle']},
 {id:'peacock',name:'Peacock',icon:'🦚',greeting:'Ta-da! Welcome to my profile!',behavior:'strut',moves:['attack','walk','idle']},
 {id:'pelican',name:'Pelican',icon:'🐦',greeting:'A beak-sized hello!',behavior:'amble',moves:['walk','attack','idle']},
 {id:'penguin',name:'Penguin',icon:'🐧',greeting:'Waddle you know, a visitor!',behavior:'waddle',moves:['walk','attack','idle']},
 {id:'rooster',name:'Rooster',icon:'🐓',greeting:'Cock-a-doodle welcome!',behavior:'strut',moves:['attack','walk','idle']},
 {id:'toucan',name:'Toucan',icon:'🦜',greeting:'Big beak, bigger hello!',behavior:'peck',moves:['walk','attack','idle']},
]



