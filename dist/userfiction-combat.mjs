//#region src/types.ts
var e = 1, t = [
	"health",
	"strength",
	"speed",
	"defense",
	"precision",
	"evasion"
], n = [
	"scheduler:interval",
	"scheduler:order",
	"action:select",
	"target:select",
	"attack:dodge",
	"attack:crit",
	"damage:base",
	"damage:mitigate",
	"ability:execute",
	"attack:pre",
	"damage:post",
	"equipment:post",
	"status:turn-end",
	"step:end",
	"outcome:decide"
], r = [
	"scheduler:interval",
	"scheduler:order",
	"action:select",
	"target:select",
	"attack:dodge",
	"attack:crit",
	"damage:base",
	"damage:mitigate",
	"ability:execute",
	"outcome:decide"
], i = [
	"attack:pre",
	"damage:post",
	"equipment:post",
	"status:turn-end",
	"step:end"
], a = ["blunt", "sharp"], o = ["weapon", "armour"], s = [
	"weapon-1",
	"weapon-2",
	"shield",
	"head",
	"body",
	"hands",
	"feet"
], c = class extends Error {
	errors;
	constructor(e) {
		super(`combat validation failed: ${e.join("; ")}`), this.name = "CombatValidationError", this.errors = e;
	}
}, l = class extends Error {
	errors;
	constructor(e) {
		super(`combat plugin error: ${e.join("; ")}`), this.name = "CombatPluginError", this.errors = e;
	}
}, u = 1e6, d = .001, f = 4294967295, p = 1e6, m = 1e5, h = 1e6, g = 1e5, _ = 1e3, v = .1, y = 1e3, b = 1e3, x = 1e3, ee = .25, te = 1e3, S = 2e3, C = .05, ne = .05, re = .005, ie = .75, w = .05, ae = 1.5, oe = .5, se = .1, T = ["weapon-1", "weapon-2"], ce = [
	"shield",
	"head",
	"body",
	"hands",
	"feet"
];
function E(e) {
	if (typeof e != "object" || !e) return e;
	if (Array.isArray(e)) return e.map((e) => E(e));
	let t = e, n = {};
	for (let e of Object.keys(t)) n[e] = E(t[e]);
	return n;
}
function D(e) {
	return {
		health: e.health,
		strength: e.strength,
		speed: e.speed,
		defense: e.defense ?? 0,
		precision: e.precision ?? 0,
		evasion: e.evasion ?? 0
	};
}
function le(e) {
	let t = {
		id: e.id,
		stacks: e.stacks ?? 1,
		potency: e.potency ?? 1
	};
	return e.duration !== void 0 && (t.duration = e.duration), t;
}
function ue(e) {
	if (typeof e.id != "string" || e.id === "") throw Error("entity seed requires a non-empty string id");
	let t = D(e.stats), n = {
		id: e.id,
		name: e.name ?? e.id,
		order: e.order,
		living: t.health > 0,
		health: t.health,
		stats: O(t, []),
		maxHealth: t.health,
		baseStats: t,
		statModifiers: [],
		statuses: (e.statuses ?? []).map(le),
		equipment: E(e.equipment ?? []),
		cooldowns: E(e.cooldowns ?? {})
	};
	return e.team !== void 0 && (n.team = e.team), n;
}
function de(e) {
	if (e.mode !== "ffa" && e.mode !== "teams") throw Error("combat state seed mode must be \"ffa\" or \"teams\"");
	return {
		mode: e.mode,
		step: e.step ?? 0,
		virtualTime: e.virtualTime ?? 0,
		rng: E(e.rng),
		entities: E(e.entities),
		schedule: E(e.schedule ?? []),
		terminal: E(e.terminal ?? null)
	};
}
function O(e, t) {
	let n = { ...e };
	for (let e of t) n[e.stat] += e.amount;
	return n.speed = Math.max(d, n.speed), n;
}
function k(e) {
	let t = {
		id: e.id,
		name: e.name,
		order: e.order,
		living: e.living,
		health: e.health,
		maxHealth: e.maxHealth,
		stats: O(e.baseStats, e.statModifiers),
		statuses: E(e.statuses),
		equipment: E(e.equipment),
		cooldowns: E(e.cooldowns)
	};
	return e.team !== void 0 && (t.team = e.team), t;
}
function A(e) {
	return {
		mode: e.mode,
		step: e.step,
		time: e.virtualTime,
		entities: e.entities.map(k)
	};
}
function fe(e) {
	return {
		step: e.step,
		virtualTime: e.virtualTime,
		rng: E(e.rng),
		entities: e.entities.map((e) => ({
			...E(e),
			stats: O(e.baseStats, e.statModifiers)
		})),
		schedule: E(e.schedule),
		terminal: E(e.terminal)
	};
}
function pe(e, t, n) {
	return {
		schemaVersion: 1,
		definition: E(t),
		state: fe(e),
		events: E(n)
	};
}
function me(e) {
	if (typeof e != "object" || !e) throw Error("restore: snapshot must be an object");
	if (e.schemaVersion !== 1) throw Error(`restore: unsupported schemaVersion: ${String(e.schemaVersion)}`);
	let t = e.definition;
	if (typeof t != "object" || !t || t.mode !== "ffa" && t.mode !== "teams") throw Error("restore: definition.mode must be \"ffa\" or \"teams\"");
	let n = e.state;
	if (typeof n != "object" || !n || !Array.isArray(n.entities)) throw Error("restore: snapshot.state.entities must be an array");
	return {
		mode: t.mode,
		step: n.step,
		virtualTime: n.virtualTime,
		rng: E(n.rng),
		entities: E(n.entities).map((e) => ({
			...e,
			stats: O(e.baseStats, e.statModifiers)
		})),
		schedule: E(n.schedule ?? []),
		terminal: E(n.terminal ?? null)
	};
}
function j(e, t) {
	let n = e.entities.find((e) => e.id === t);
	if (!n) throw Error(`unknown entity id: '${t}'`);
	return n;
}
function he(e, t, n) {
	if (typeof n != "number" || !Number.isFinite(n) || n < 0) throw Error("damage amount must be a finite number >= 0");
	let r = j(e, t);
	if (!r.living) return {
		entityId: t,
		applied: 0,
		health: r.health,
		killed: !1
	};
	let i = Math.max(0, r.health - n), a = r.health - i, o = i === 0;
	return r.health = i, r.living = i > 0, {
		entityId: t,
		applied: a,
		health: i,
		killed: o
	};
}
function ge(e, t, n) {
	if (typeof n != "number" || !Number.isFinite(n) || n < 0) throw Error("heal amount must be a finite number >= 0");
	let r = j(e, t);
	if (!r.living) return {
		entityId: t,
		applied: 0,
		health: r.health
	};
	let i = Math.min(n, r.maxHealth - r.health);
	return r.health += i, {
		entityId: t,
		applied: i,
		health: r.health
	};
}
function _e(e, t, n, r = {}) {
	let i = j(e, t), a = r.stacks ?? 1;
	if (typeof a != "number" || !Number.isFinite(a) || a < 0) throw Error("status stacks must be a finite number >= 0");
	let o = Math.min(1, Math.max(0, r.resistance ?? 0));
	if (o >= 1) return { kind: "resisted" };
	let s = Math.floor(a * (1 - o)), c = i.statuses.find((e) => e.id === n);
	if (!c) {
		if (s <= 0) return { kind: "resisted" };
		let e = {
			id: n,
			stacks: Math.min(s, 9),
			potency: r.potency ?? 1
		};
		return r.duration !== void 0 && (e.duration = r.duration), i.statuses.push(e), {
			kind: "applied",
			status: E(e)
		};
	}
	c.stacks = Math.min((c.stacks ?? 1) + s, 9);
	let l = Math.max(c.duration ?? 0, r.duration ?? 0);
	return l > 0 && (c.duration = l), c.potency = c.potency ?? r.potency ?? 1, {
		kind: "refreshed",
		status: E(c)
	};
}
function ve(e, t, n) {
	let r = j(e, t), i = r.statuses.findIndex((e) => e.id === n);
	return i < 0 ? !1 : (r.statuses.splice(i, 1), !0);
}
function ye(e, t, n, r, i) {
	if (typeof r != "number" || !Number.isFinite(r)) throw Error("stat modifier amount must be a finite number");
	if (typeof i != "number" || !Number.isInteger(i) || i < 0) throw Error("stat modifier remainingTurns must be an integer >= 0");
	let a = j(e, t), o = {
		stat: n,
		amount: r,
		remainingTurns: i
	};
	return a.statModifiers.push(o), E(o);
}
function be(e, t) {
	let n = j(e, t), r = [], i = [];
	for (let e of n.statModifiers) {
		if (e.remainingTurns <= 0) {
			i.push(e);
			continue;
		}
		--e.remainingTurns, e.remainingTurns === 0 ? r.push(E(e)) : i.push(e);
	}
	return n.statModifiers = i, r;
}
function xe(e, t, n, r = 1) {
	if (typeof r != "number" || !Number.isFinite(r) || r < 0) throw Error("gear damage amount must be a finite number >= 0");
	let i = j(e, t).equipment.find((e) => e.slot === n);
	return i ? (i.durability = Math.max(0, i.durability - r), {
		gearId: i.gearId,
		slot: i.slot,
		durability: i.durability,
		broken: i.durability === 0
	}) : null;
}
function Se(e, t, n) {
	let r = j(e, t), i = r.equipment.findIndex((e) => e.slot === n);
	if (i < 0) return null;
	let [a] = r.equipment.splice(i, 1);
	return E(a);
}
function Ce(e, t, n) {
	let r = j(e, t), i = (e) => n === void 0 ? T.includes(e.slot) : e.slot === n, a = [], o = [];
	for (let e of r.equipment) (i(e) ? a : o).push(e);
	return r.equipment = o, E(a);
}
function we(e, t) {
	let n = e.schedule.length;
	return e.schedule = e.schedule.filter((e) => e.entityId !== t), n - e.schedule.length;
}
//#endregion
//#region src/rng.ts
var Te = 4294967296, Ee = 1831565813, De = (e) => {
	let t = e + Ee >>> 0, n = Math.imul(t ^ t >>> 15, 1 | t);
	return n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n, {
		state: t,
		out: (n ^ n >>> 14) >>> 0
	};
}, Oe = (e = 1) => {
	let t = e >>> 0, n = e >>> 0, r = 0, i = () => {
		let e = De(t);
		return t = e.state, r += 1, e.out / Te;
	}, a = (e) => {
		let t = Math.floor(i() * e);
		return t < 0 ? 0 : t;
	};
	return {
		next: i,
		int: a,
		pick: (e) => e[a(e.length)],
		exportState: () => ({
			seed: n,
			state: t,
			draws: r
		}),
		restoreState: (e) => {
			n = e.seed >>> 0, t = e.state >>> 0, r = e.draws;
		}
	};
}, ke = (e) => {
	let t = [], n = 1;
	return {
		emit: (e, r, i) => {
			let a = {
				id: n++,
				step: r,
				time: i,
				type: e.type,
				...e.actor === void 0 ? {} : { actor: e.actor },
				...e.target === void 0 ? {} : { target: e.target },
				...e.message === void 0 ? {} : { message: e.message },
				...e.payload === void 0 ? {} : { payload: JSON.parse(JSON.stringify(e.payload)) }
			};
			return t.push(a), a;
		},
		all: () => t,
		count: () => t.length,
		nextEventId: () => n,
		marker: () => ({
			length: t.length,
			nextId: n
		}),
		rollback: (e) => {
			t.length = e.length, n = e.nextId;
		},
		restore: (e) => {
			t.length = 0, t.push(...JSON.parse(JSON.stringify(e)));
			let r = 0;
			for (let e of t) e.id > r && (r = e.id);
			n = r + 1;
		},
		clear: () => {
			t.length = 0, n = 1;
		},
		trim: (r, i) => {
			if (t.length <= e) return 0;
			let a = t.length - e + 1;
			t.splice(0, a);
			let o = {
				type: "log-trimmed",
				payload: { dropped: a }
			}, s = {
				id: n++,
				step: r,
				time: i,
				...o
			};
			return t.push(s), a;
		}
	};
}, M = (e, t) => {
	if (e === void 0) return;
	let n = t?.state.entities.find((t) => t.id === e);
	return n ? n.name : e;
}, N = (e, t) => {
	let n = e?.[t];
	return typeof n == "number" ? n : void 0;
}, P = (e, t) => {
	let n = e?.[t];
	return typeof n == "string" ? n : void 0;
}, Ae = (e, t) => e?.[t] === !0, je = (e) => {
	let t = e?.mitigations;
	return typeof t == "object" && t ? t : void 0;
}, Me = {
	"battle:start": (e) => {
		let t = P(e.payload, "mode") ?? "?", n = N(e.payload, "seed");
		return `Battle begins (${t} mode${n === void 0 ? "" : `, seed ${n}`})`;
	},
	"turn:start": (e, t) => `${M(e.actor, t) ?? "?"}'s turn`,
	action: (e, t) => {
		let n = M(e.actor, t) ?? "?", r = P(e.payload, "kind") ?? "?";
		if (r === "attack") return `${n} attacks`;
		if (r === "ability") return `${n} uses ${P(e.payload, "abilityId") ?? "?"}`;
		if (r === "wait") return `${n} waits`;
		let i = P(e.payload, "reason");
		return i ? `${n} skips (${i})` : `${n} skips`;
	},
	dodge: (e, t) => `${M(e.actor, t) ?? "?"} dodges ${M(e.target, t) ?? "?"}'s attack`,
	crit: (e, t) => `${M(e.actor, t) ?? "?"} lands a critical hit!`,
	block: (e, t) => `${M(e.actor, t) ?? "?"} blocks the attack!`,
	damage: (e, t) => {
		let n = N(e.payload, "amount") ?? 0, r = P(e.payload, "damageType") ?? "damage", i = P(e.payload, "source") ?? "effect", a = M(e.actor, t), o = M(e.target, t) ?? "?", s = P(e.payload, "weaponId"), c;
		return c = i === "poison" ? `${o} suffers poison for ${n} ${r} damage` : i === "effect" ? `${o} takes ${n} ${r} damage` : s === void 0 ? `${a ?? "?"} hits ${o} bare-handed for ${n} ${r} damage` : `${a ?? "?"} hits ${o} with ${s} for ${n} ${r} damage`, Ae(e.payload, "crit") && (c += " (crit!)"), je(e.payload)?.blocked === !0 && (c += " (blocked)"), c;
	},
	heal: (e, t) => {
		let n = N(e.payload, "amount") ?? 0, r = M(e.actor, t), i = M(e.target, t);
		return i !== void 0 && i !== r ? `${r ?? "?"} heals ${i} for ${n}` : `${r ?? "?"} heals for ${n}`;
	},
	"status:applied": (e, t) => {
		let n = P(e.payload, "statusId") ?? "?", r = N(e.payload, "stacks") ?? 1, i = N(e.payload, "duration"), a = N(e.payload, "potency"), o = [`stacks ${r}`];
		return i !== void 0 && o.push(`duration ${i}`), a !== void 0 && o.push(`potency ${a}`), `${M(e.actor, t) ?? "?"} gains ${n} (${o.join(", ")})`;
	},
	"status:resisted": (e, t) => `${M(e.actor, t) ?? "?"} resists ${P(e.payload, "statusId") ?? "?"}`,
	"status:tick": (e, t) => {
		let n = P(e.payload, "statusId") ?? "?", r = N(e.payload, "damage");
		return r === void 0 ? `${M(e.actor, t) ?? "?"} suffers ${n}` : `${M(e.actor, t) ?? "?"} suffers ${n} for ${r} damage`;
	},
	"status:expired": (e, t) => `${M(e.actor, t) ?? "?"}'s ${P(e.payload, "statusId") ?? "?"} fades`,
	"stat:modified": (e, t) => `${M(e.target ?? e.actor, t) ?? "?"}'s ${P(e.payload, "stat") ?? "?"} changes by ${N(e.payload, "amount") ?? 0}`,
	"stat:expired": (e, t) => `${M(e.actor, t) ?? "?"}'s ${P(e.payload, "stat") ?? "?"} modifier fades`,
	"gear:damaged": (e, t) => `${M(e.actor, t) ?? "?"}'s ${P(e.payload, "gearId") ?? "?"} wears (${N(e.payload, "durability") ?? 0} durability left)`,
	"gear:broken": (e, t) => `${M(e.actor, t) ?? "?"}'s ${P(e.payload, "gearId") ?? "?"} breaks!`,
	death: (e, t) => {
		let n = M(P(e.payload, "killerId"), t), r = M(e.actor, t) ?? "?";
		return n ? `${r} falls, slain by ${n}` : `${r} falls`;
	},
	"log-trimmed": (e) => `Log trimmed (${N(e.payload, "dropped") ?? 0} events dropped)`,
	"step:end": (e) => `End of step ${N(e.payload, "step") ?? e.step}`,
	outcome: (e, t) => {
		let n = P(e.payload, "outcome") ?? "?", r = M(P(e.payload, "winner"), t), i = P(e.payload, "reason");
		return n === "victory" ? `Victory: ${r ?? "?"}` : n === "draw" ? `Draw${i ? ` (${i})` : ""}` : n === "undecided" ? `Undecided${i ? ` (${i})` : ""}` : `Fault${i ? ` (${i})` : ""}`;
	},
	fault: (e) => {
		let t = P(e.payload, "pluginId"), n = P(e.payload, "hook"), r = P(e.payload, "error") ?? e.message ?? "unknown error", i = [t, n].filter(Boolean).join(" at ");
		return i ? `Fault in ${i}: ${r}` : `Fault: ${r}`;
	},
	message: (e) => e.message ?? ""
}, Ne = (e, t) => {
	let n = Me[e.type];
	return n ? n(e, t) : `[${e.type}] ${e.message ?? ""}`;
}, Pe = /^[a-z0-9][a-z0-9-]*$/, F = (e) => typeof e == "string" && Pe.test(e), Fe = (e, t) => `${e}/${t}`, Ie = [
	"attacker",
	"target",
	"self"
], Le = [
	"lt",
	"lte",
	"gt",
	"gte",
	"eq"
], Re = [
	"blunt",
	"sharp",
	"true"
], ze = (e) => typeof e == "object" && !!e && !Array.isArray(e), Be = (e) => e.includes("/");
function Ve(e) {
	let { type: t, ...n } = e;
	return n;
}
function He() {
	throw Error("interpreter depth exceeded (max 16)");
}
function I(e, t, n, r) {
	if (typeof e != "number" || !Number.isFinite(e)) throw Error(`malformed '${t}' ${n}: '${r}' must be a finite number`);
	return e;
}
function Ue(e, t, n, r) {
	if (e != null) return I(e, t, n, r);
}
function L(e, t, n) {
	let r = e.ref ?? e.target;
	if (!Ie.includes(r)) throw Error(`malformed '${t}' ${n}: invalid ref '${String(r)}'`);
	return r;
}
function R(e, t) {
	if (e === "attacker") return t.refs.actor.id;
	if (e === "target") {
		if (!t.refs.target) throw Error("unresolvable ref: 'target'");
		return t.refs.target.id;
	}
	return (t.refs.self ?? t.refs.actor).id;
}
function We(e, t) {
	let n = R(e, t.ctx), r = t.view.entities.find((e) => e.id === n);
	if (!r) throw Error(`ref '${e}' not present in view`);
	return r;
}
function Ge(e, t) {
	return Ke(e, t, 1);
}
function Ke(e, n, r) {
	if (r > 16 && He(), !ze(e) || typeof e.type != "string") throw Error(`malformed condition: ${JSON.stringify(e)}`);
	let i = e.type;
	switch (i) {
		case "always": return !0;
		case "never": return !1;
		case "stat": {
			let r = L(e, "stat", "condition"), i = e.stat;
			if (!t.includes(i)) throw Error(`malformed 'stat' condition: invalid stat '${String(i)}'`);
			let a = e.op;
			if (!Le.includes(a)) throw Error(`malformed 'stat' condition: invalid op '${String(a)}'`);
			let o = I(e.value, "stat", "condition", "value"), s = We(r, n), c = i === "health" ? s.health : s.stats[i];
			switch (a) {
				case "lt": return c < o;
				case "lte": return c <= o;
				case "gt": return c > o;
				case "gte": return c >= o;
				case "eq": return c === o;
				default: return !1;
			}
		}
		case "has-status": {
			let t = L(e, "has-status", "condition"), r = e.status;
			if (typeof r != "string" || r === "") throw Error("malformed 'has-status' condition: 'status' must be a non-empty string");
			return We(t, n).statuses.some((e) => e.id === r);
		}
		case "has-gear": {
			let t = L(e, "has-gear", "condition"), r = e.kind;
			if (r != null && !o.includes(r)) throw Error(`malformed 'has-gear' condition: invalid kind '${String(r)}'`);
			let i = e.slot;
			if (i != null && !s.includes(i)) throw Error(`malformed 'has-gear' condition: invalid slot '${String(i)}'`);
			return We(t, n).equipment.some((e) => (i == null || e.slot === i) && (r == null || (r === "weapon" ? T.includes(e.slot) : ce.includes(e.slot))));
		}
		case "mode": {
			let t = e.is;
			if (t !== "ffa" && t !== "teams") throw Error(`malformed 'mode' condition: invalid is '${String(t)}'`);
			return n.view.mode === t;
		}
		case "chance": {
			let t = I(e.p, "chance", "condition", "p");
			return n.ctx.rng.next() < t;
		}
		case "all":
		case "any": {
			let t = e.of;
			if (!Array.isArray(t)) throw Error(`malformed '${i}' condition: 'of' must be an array`);
			if (t.length > 32) throw Error("condition list exceeds the 32-item bound");
			for (let e of t) {
				let t = Ke(e, n, r + 1);
				if (i === "all" && !t) return !1;
				if (i === "any" && t) return !0;
			}
			return i === "all";
		}
		case "not": return !Ke(e.of, n, r + 1);
		default:
			if (Be(i)) {
				let t = n.vocab.condition(i);
				if (!t) throw Error(`unknown condition type: '${i}'`);
				let r = t(n.view, n.ctx, Ve(e));
				if (typeof r != "boolean") throw Error(`vocab condition '${i}' must return a boolean`);
				return r;
			}
			throw Error(`unknown condition type: '${i}'`);
	}
}
function qe(e, t) {
	Je(e, t, 1);
}
function Je(e, n, r) {
	if (r > 16 && He(), !Array.isArray(e)) throw Error("effects must be an array");
	if (e.length > 32) throw Error("effect list exceeds the 32-item bound");
	for (let i of e) {
		if (!ze(i) || typeof i.type != "string") throw Error(`malformed effect: ${JSON.stringify(i)}`);
		let e = i.type;
		switch (e) {
			case "strike":
				n.adapter.strike();
				break;
			case "damage-flat": {
				let e = R(L(i, "damage-flat", "effect"), n.ctx), t = I(i.amount, "damage-flat", "effect", "amount"), r = i.damageType;
				if (r != null && !Re.includes(r)) throw Error(`malformed 'damage-flat' effect: invalid damageType '${String(r)}'`);
				n.adapter.damageFlat(e, t, r);
				break;
			}
			case "heal": {
				let e = R(L(i, "heal", "effect"), n.ctx), t = I(i.amount, "heal", "effect", "amount");
				n.adapter.heal(e, t);
				break;
			}
			case "apply-status": {
				let e = R(L(i, "apply-status", "effect"), n.ctx), t = i.status;
				if (typeof t != "string" || t === "") throw Error("malformed 'apply-status' effect: 'status' must be a non-empty string");
				n.adapter.applyStatus(e, t, Ue(i.stacks, "apply-status", "effect", "stacks"), Ue(i.duration, "apply-status", "effect", "duration"), Ue(i.potency, "apply-status", "effect", "potency"));
				break;
			}
			case "remove-status": {
				let e = R(L(i, "remove-status", "effect"), n.ctx), t = i.status;
				if (typeof t != "string" || t === "") throw Error("malformed 'remove-status' effect: 'status' must be a non-empty string");
				n.adapter.removeStatus(e, t);
				break;
			}
			case "break-equipment": {
				let e = R(L(i, "break-equipment", "effect"), n.ctx), t = i.slot;
				if (t != null && !s.includes(t)) throw Error(`malformed 'break-equipment' effect: invalid slot '${String(t)}'`);
				n.adapter.breakEquipment(e, t ?? void 0);
				break;
			}
			case "modify-stat": {
				let e = R(L(i, "modify-stat", "effect"), n.ctx), r = i.stat;
				if (!t.includes(r)) throw Error(`malformed 'modify-stat' effect: invalid stat '${String(r)}'`);
				let a = I(i.amount, "modify-stat", "effect", "amount"), o = Ue(i.duration, "modify-stat", "effect", "duration");
				n.adapter.modifyStat(e, r, a, o);
				break;
			}
			case "emit": {
				let e = i.message;
				if (typeof e != "string") throw Error("malformed 'emit' effect: 'message' must be a string");
				n.adapter.emitMessage(e);
				break;
			}
			default:
				if (Be(e)) {
					let t = n.vocab.effect(e);
					if (!t) throw Error(`unknown effect type: '${e}'`);
					let a = t(n.view, n.ctx, Ve(i));
					if (!Array.isArray(a)) throw Error(`vocab effect '${e}' must return an EffectDescriptor[]`);
					Je(a, n, r + 1);
					break;
				}
				throw Error(`unknown effect type: '${e}'`);
		}
	}
}
//#endregion
//#region src/plugins.ts
var Ye = "@definition/rules", z = (e) => typeof e == "object" && !!e && !Array.isArray(e), B = (e, t) => e.includes(t);
function Xe(e, t, i, a) {
	if (!z(e)) {
		a.push(`plugin ${t} must be an object`);
		return;
	}
	let o = e.id;
	if (typeof o != "string" || o === "") {
		a.push(`plugin ${t} requires a non-empty string id`);
		return;
	}
	let s = `'${o}'`, c = e.overrides, l = [];
	if (c !== void 0) if (!Array.isArray(c)) a.push(`plugin ${s} overrides must be an array`);
	else for (let e of c) {
		if (typeof e != "string") {
			a.push(`plugin ${s} overrides entries must be strings`);
			continue;
		}
		if (B(r, e)) {
			l.push(e);
			continue;
		}
		B(n, e) ? a.push(`plugin ${s} lists chain-mode hook in overrides: '${e}'`) : a.push(`plugin ${s} lists unknown hook id in overrides: '${e}'`);
	}
	let u = e.hooks;
	if (u !== void 0) if (!z(u)) a.push(`plugin ${s} hooks must be an object`);
	else for (let e of Object.keys(u)) {
		if (!B(n, e)) {
			a.push(`plugin ${s} uses unknown hook id: '${e}'`);
			continue;
		}
		let t = u[e];
		if (B(r, e)) typeof t == "function" || (Array.isArray(t) ? a.push(`plugin ${s} ships an array for single-mode hook '${e}'`) : a.push(`plugin ${s} ships a non-function handler for hook '${e}'`)), !i && !l.includes(e) && a.push(`plugin ${s} ships single-mode handler '${e}' without declaring it in overrides`);
		else if (typeof t != "function") if (Array.isArray(t)) {
			for (let n of t) if (typeof n != "function") {
				a.push(`plugin ${s} ships a non-function handler for hook '${e}'`);
				break;
			}
		} else a.push(`plugin ${s} ships a non-function handler for hook '${e}'`);
	}
	let d = e.vocab;
	if (d !== void 0) if (!z(d)) a.push(`plugin ${s} vocab must be an object`);
	else for (let e of ["conditions", "effects"]) {
		let t = d[e];
		if (t !== void 0) {
			if (!z(t)) {
				a.push(`plugin ${s} vocab ${e} must be an object`);
				continue;
			}
			for (let n of Object.keys(t)) (n === "" || n.includes("/")) && a.push(`plugin ${s} vocab ${e} key must be a short name without '/': '${n}'`), typeof t[n] != "function" && a.push(`plugin ${s} vocab ${e} handler for '${n}' is not a function`);
		}
	}
}
function Ze(e, t) {
	let n = e.hooks;
	if (z(n)) for (let e of Object.keys(n)) {
		if (!B(i, e)) continue;
		let r = n[e], a = typeof r == "function" ? 1 : Array.isArray(r) ? r.length : 0;
		t.set(e, (t.get(e) ?? 0) + a);
	}
}
function Qe(e, t) {
	let n = /* @__PURE__ */ new Set();
	for (let r of e) {
		if (!z(r)) {
			t.push("each declarative rule must be an object");
			continue;
		}
		let e = typeof r.id == "string" && r.id !== "" ? r.id : void 0;
		e === void 0 && t.push("each declarative rule requires a non-empty string id");
		let a = r.hook;
		typeof a != "string" || !B(i, a) ? t.push(`rule '${e ?? "?"}' hook must be a chain-mode hook: ${typeof a == "string" ? `'${a}'` : String(a)}`) : n.add(a), Array.isArray(r.effects) || t.push(`rule '${e ?? "?"}' effects must be an array`), r.when !== void 0 && !z(r.when) && t.push(`rule '${e ?? "?"}' when must be a condition object`);
	}
	return n;
}
function $e(e) {
	let t = [], n = e.builtin, a = e.plugins ?? [], o = e.rules ?? [];
	n !== void 0 && Xe(n, "builtin", !0, t), a.forEach((e, n) => Xe(e, `at index ${n}`, !1, t)), n !== void 0 && z(n) && n.id === "@definition/rules" && t.push(`plugin id reserved for JSON contributions: '${Ye}'`);
	for (let e of a) z(e) && e.id === "@definition/rules" && t.push(`plugin id reserved for JSON contributions: '${Ye}'`);
	let s = /* @__PURE__ */ new Set();
	for (let e of [n, ...a]) e === void 0 || !z(e) || typeof e.id != "string" || e.id === "" || (s.has(e.id) ? t.push(`duplicate plugin id: '${e.id}'`) : s.add(e.id));
	let c = Qe(o, t);
	o.length > 0 && e.runtime === void 0 && t.push("JSON rules require an effect runtime provider");
	let u = /* @__PURE__ */ new Map();
	n !== void 0 && z(n) && Ze(n, u);
	for (let e of a) z(e) && Ze(e, u);
	for (let e of c) u.set(e, (u.get(e) ?? 0) + 1);
	for (let e of i) (u.get(e) ?? 0) > 32 && t.push(`chain hook '${e}' exceeds the 32-handler bound`);
	if (t.length > 0) throw new l(t);
	let d = /* @__PURE__ */ new Map(), f = /* @__PURE__ */ new Map();
	for (let e of [n, ...a]) {
		if (e === void 0) continue;
		let t = e.vocab;
		if (t) {
			if (t.conditions) for (let [n, r] of Object.entries(t.conditions)) d.set(Fe(e.id, n), r);
			if (t.effects) for (let [n, r] of Object.entries(t.effects)) f.set(Fe(e.id, n), r);
		}
	}
	let p = {
		condition: (e) => d.get(e),
		effect: (e) => f.get(e)
	}, m;
	if (o.length > 0) {
		let t = /* @__PURE__ */ new Map();
		for (let e of o) {
			let n = t.get(e.hook) ?? [];
			n.push(e), t.set(e.hook, n);
		}
		let n = {};
		for (let [r, i] of t) n[r] = (t, n) => {
			let r = e.runtime();
			for (let e of i) {
				let t = {
					view: r.view(),
					ctx: n,
					vocab: p,
					adapter: r.adapter
				};
				e.when !== void 0 && !Ge(e.when, t) || qe(e.effects, t);
			}
		};
		m = {
			id: Ye,
			hooks: n
		};
	}
	let h = [];
	n !== void 0 && h.push(n), h.push(...a), m !== void 0 && h.push(m);
	let g = /* @__PURE__ */ new Map(), _ = /* @__PURE__ */ new Map();
	for (let e of i) {
		let t = [], n = [];
		for (let r of h) {
			let i = r.hooks?.[e];
			if (i !== void 0) {
				if (typeof i == "function") t.push(i), n.push(r.id);
				else if (Array.isArray(i)) {
					t.push(...i);
					for (let e = 0; e < i.length; e += 1) n.push(r.id);
				}
			}
		}
		g.set(e, Object.freeze(t)), _.set(e, Object.freeze(n));
	}
	let v = /* @__PURE__ */ new Map();
	for (let e of r) {
		let t;
		for (let n = h.length - 1; n >= 0; --n) {
			let r = h[n];
			if (r.overrides?.includes(e) && typeof r.hooks?.[e] == "function") {
				t = {
					handler: r.hooks[e],
					owner: r.id
				};
				break;
			}
		}
		t === void 0 && typeof n?.hooks?.[e] == "function" && (t = {
			handler: n.hooks[e],
			owner: n.id
		}), t !== void 0 && v.set(e, t);
	}
	let y = Object.freeze([]);
	return Object.freeze([]), {
		pluginIds: () => h.map((e) => e.id),
		single: (e) => v.get(e)?.handler,
		singleOwner: (e) => v.get(e)?.owner,
		chain: (e) => g.get(e) ?? y,
		chainOwner: (e, t) => _.get(e)?.[t],
		vocab: p
	};
}
//#endregion
//#region src/scheduler.ts
var V = (e) => {
	let t = Math.max(d, e.effectiveSpeed), n = e.actionCost * u / t;
	return Math.max(1, Math.round(n));
}, et = (e) => {
	let t = Infinity;
	for (let n of e.candidates) n.readyAt < t && (t = n.readyAt);
	let n = e.candidates.filter((e) => e.readyAt === t);
	return n.sort((e, t) => t.effectiveSpeed - e.effectiveSpeed || e.order - t.order), n[0].entityId;
}, tt = (e, t = V) => e.map((e) => ({
	entityId: e.entityId,
	readyAt: t({
		entityId: e.entityId,
		actionCost: e.actionCost,
		effectiveSpeed: e.effectiveSpeed
	})
})), nt = (e, t, n) => {
	let r = e.find((e) => e.entityId === t);
	r ? r.readyAt = n : e.push({
		entityId: t,
		readyAt: n
	});
}, rt = (e) => {
	let t = null;
	for (let n of e) (t === null || n.readyAt < t) && (t = n.readyAt);
	return t;
}, it = (e, t) => {
	let n = rt(e);
	return n === null ? [] : e.filter((e) => e.readyAt === n).map((e) => ({
		entityId: e.entityId,
		readyAt: e.readyAt,
		effectiveSpeed: t(e.entityId).effectiveSpeed,
		order: t(e.entityId).order
	}));
}, at = (e, t, n = et) => {
	let r = it(e, t);
	if (r.length === 0) return null;
	let i = n({ candidates: r }), a = e.find((e) => e.entityId === i);
	return a ? {
		entry: a,
		time: a.readyAt
	} : null;
}, ot = (e, t, n, r, i, a = V) => {
	nt(e, t, n + a({
		entityId: t,
		actionCost: r,
		effectiveSpeed: i
	}));
}, st = (e, t, n, r, i, a = V) => {
	let o = e.find((e) => e.entityId === t);
	if (!o || o.readyAt <= n) return !1;
	let s = a({
		entityId: t,
		actionCost: (o.readyAt - n) * r / u,
		effectiveSpeed: i
	});
	return o.readyAt = n + Math.max(1, Math.round(s)), !0;
}, H = [
	{
		id: "rusted-dagger",
		name: "Rusted Dagger",
		kind: "weapon",
		slot: "weapon-1",
		handedness: 1,
		type: "sharp",
		damage: 3,
		blunt: 0,
		sharp: 0,
		durability: 8
	},
	{
		id: "iron-mace",
		name: "Iron Mace",
		kind: "weapon",
		slot: "weapon-1",
		handedness: 1,
		type: "blunt",
		damage: 5,
		blunt: 0,
		sharp: 0,
		durability: 10
	},
	{
		id: "great-axe",
		name: "Great Axe",
		kind: "weapon",
		slot: "weapon-1",
		handedness: 2,
		type: "sharp",
		damage: 8,
		blunt: 0,
		sharp: 0,
		durability: 10
	},
	{
		id: "buckler",
		name: "Buckler",
		kind: "armour",
		slot: "shield",
		handedness: 1,
		type: "sharp",
		damage: 0,
		blunt: .1,
		sharp: .1,
		durability: 6
	},
	{
		id: "padded-vest",
		name: "Padded Vest",
		kind: "armour",
		slot: "body",
		handedness: 0,
		type: "sharp",
		damage: 0,
		blunt: .2,
		sharp: .1,
		durability: 10
	},
	{
		id: "iron-helm",
		name: "Iron Helm",
		kind: "armour",
		slot: "head",
		handedness: 0,
		type: "sharp",
		damage: 0,
		blunt: .1,
		sharp: .2,
		durability: 8
	}
], ct = (e) => typeof e == "object" && !!e && !Array.isArray(e) && (Object.getPrototypeOf(e) === Object.prototype || Object.getPrototypeOf(e) === null), lt = (e = {}) => {
	let t = /* @__PURE__ */ new Map();
	return (e.seed === void 0 ? H : e.seed).forEach((e) => t.set(e.id, { ...e })), {
		define: (e) => {
			let n = t.get(e.id), r = n ? { ...n } : {};
			Object.entries(e).forEach(([e, t]) => {
				t !== void 0 && (r[e] = t);
			});
			let i = r;
			return t.set(i.id, i), { ...i };
		},
		definitionOf: (e) => {
			let n = t.get(e);
			return n ? { ...n } : void 0;
		},
		has: (e) => t.has(e),
		all: () => Array.from(t.values()).map((e) => ({ ...e })),
		count: () => t.size,
		remove: (e) => t.delete(e),
		clear: () => {
			t.clear();
		}
	};
}, ut = (e, t) => {
	let n = /* @__PURE__ */ new Map();
	return e.forEach((e) => n.set(e.id, { ...e })), Array.isArray(t) && t.forEach((e) => {
		if (!ct(e) || typeof e.id != "string") return;
		let t = n.get(e.id), r = t ? { ...t } : {};
		Object.entries(e).forEach(([e, t]) => {
			t !== void 0 && (r[e] = t);
		}), n.set(e.id, r);
	}), Array.from(n.values());
}, dt = (e) => {
	if (Array.isArray(e)) return e.map((e) => dt(e));
	if (ct(e)) {
		let t = {};
		return Object.entries(e).forEach(([e, n]) => {
			typeof n != "function" && typeof n != "symbol" && (t[e] = dt(n));
		}), t;
	}
	return e;
}, ft = (e) => {
	let t = dt(e);
	return t.catalogs && (t.catalogs.gear = ut(H, t.catalogs.gear)), t;
}, pt = "@userfiction/combat/rules", mt = Symbol.for("@userfiction/combat/defaultRules"), ht = (e) => typeof e == "object" && !!e && e[mt] === !0, gt = (e, t) => e.entities.filter((n) => n.living && n.id !== t.id && (e.mode === "teams" ? n.team !== t.team : !0)), _t = (e) => e.entities.some((t) => t.living && gt(e, t).length > 0), vt = () => {
	let e = () => {
		throw Error("EffectAdapter used from a read-only condition context");
	};
	return {
		strike: e,
		damageFlat: e,
		heal: e,
		applyStatus: e,
		removeStatus: e,
		breakEquipment: e,
		modifyStat: e,
		emitMessage: e
	};
}, yt = (e = {}) => {
	let t = e.gear ?? H, n = new Map(t.map((e) => [e.id, e])), r = new Map((e.abilities ?? []).map((e) => [e.id, e])), i = e.vocab ?? {
		condition: () => void 0,
		effect: () => void 0
	}, a = vt(), o = {
		id: pt,
		hooks: {
			"scheduler:interval": (e, t, n) => V(n),
			"scheduler:order": (e, t, n) => et(n),
			"action:select": (e, t, n) => {
				let r = n.actor;
				if (r.statuses.some((e) => e.id === "stun")) return {
					kind: "skip",
					reason: "stunned"
				};
				let i = r.statuses.find((e) => e.id === "fear");
				if (i && t.rng.next() < .25 * (i.stacks ?? 1)) return {
					kind: "skip",
					reason: "feared"
				};
				let a = gt(e, r), o = [];
				a.length > 0 && o.push({ kind: "attack" });
				for (let n of Object.keys(r.cooldowns)) {
					if ((r.cooldowns[n] ?? 0) > 0) continue;
					let i = s(n);
					i && a.length !== 0 && (i.conditions && !Ge(i.conditions, c(e, t)) || o.push({
						kind: "ability",
						abilityId: n
					}));
				}
				return o.length === 0 ? { kind: "wait" } : o.length === 1 ? o[0] : t.rng.pick(o);
			},
			"target:select": (e, t, n) => {
				let r = n.actor, i = gt(e, r);
				return i.length === 0 ? null : t.rng.pick(i).id;
			},
			"attack:dodge": (e, t, n) => {
				let { attacker: r, target: i } = n, a = Math.min(ie, Math.max(0, ne + (i.stats.evasion - r.stats.precision) * re));
				return { dodged: t.rng.next() < a };
			},
			"attack:crit": (e, t) => ({ crit: t.rng.next() < w }),
			"damage:base": (e, t, r) => {
				let { attacker: i, weapon: a } = r, o = 1 + C * i.stats.strength;
				if (a) {
					let e = n.get(a.gearId);
					if (e) return {
						amount: e.damage * o,
						damageType: e.type
					};
				}
				return {
					amount: 1 * o,
					damageType: "blunt"
				};
			},
			"damage:mitigate": (e, t, r) => {
				let { target: i, amount: a, damageType: o } = r, s = 1, c = !1;
				i.equipment.find((e) => e.slot === "shield") !== void 0 && t.rng.next() < .15 && (c = !0, s *= oe);
				let l = 1;
				for (let e of i.equipment) {
					if (!ce.includes(e.slot)) continue;
					let t = n.get(e.gearId);
					if (!t) continue;
					let r = o === "blunt" ? t.blunt : t.sharp;
					r > 0 && (l *= 1 - r);
				}
				l = Math.max(se, l);
				let u = 100 / (100 + i.stats.defense);
				return {
					amount: Math.max(1, Math.round(a * s * l * u)),
					blocked: c,
					armourFactor: l,
					defenseFactor: u
				};
			},
			"ability:execute": (e, t, n) => {
				let { ability: r } = n;
				return r.effects.map((e) => ({ ...e }));
			},
			"outcome:decide": (e, t, n) => {
				let { step: r, config: i } = n, a = e.entities.filter((e) => e.living);
				if (a.length === 0) return {
					outcome: "draw",
					reason: "mutual-destruction"
				};
				if (r === 0 && !_t(e)) return {
					outcome: "draw",
					reason: "no-enemies"
				};
				if (e.mode === "teams") {
					if (new Set(a.map((e) => e.team)).size === 1) return {
						outcome: "victory",
						winner: a[0].team
					};
				} else if (a.length === 1) return {
					outcome: "victory",
					winner: a[0].id
				};
				return r >= i.maxSteps ? {
					outcome: "undecided",
					reason: "step-limit"
				} : null;
			}
		}
	};
	return Object.defineProperty(o, mt, { value: !0 }), o;
	function s(e) {
		return r.get(e);
	}
	function c(e, t) {
		return {
			view: e,
			ctx: t,
			vocab: i,
			adapter: a
		};
	}
}, bt = (e, t) => {
	let n = (t, n) => {
		let r = e.damageGear(t, n, 1);
		r && (e.emit({
			type: "gear:damaged",
			actor: t,
			payload: {
				gearId: r.gearId,
				slot: r.slot,
				durability: r.durability
			}
		}), r.broken && (e.removeGear(t, n), e.emit({
			type: "gear:broken",
			actor: t,
			payload: {
				gearId: r.gearId,
				slot: r.slot
			}
		})));
	};
	if (t.attacker && t.weapon && n(t.attacker.id, t.weapon.slot), t.target) for (let e of t.contributedArmour ?? []) n(t.target.id, e.slot);
}, xt = (e, t) => {
	let n = t.entity;
	for (let t of n.statuses) {
		let r = t.stacks ?? 1, i = t.potency ?? 1;
		if (t.id === "fear") {
			let t = r - 1;
			t <= 0 ? (e.removeStatus(n.id, "fear"), e.emit({
				type: "status:expired",
				actor: n.id,
				payload: { statusId: "fear" }
			})) : e.patchStatus(n.id, "fear", { stacks: t });
		} else if (t.id === "poison") {
			let a = e.damageEntity(n.id, i * r);
			e.emit({
				type: "status:tick",
				actor: n.id,
				payload: {
					statusId: "poison",
					damage: a.applied
				}
			}), e.emit({
				type: "damage",
				actor: n.id,
				target: n.id,
				payload: {
					amount: a.applied,
					damageType: "true",
					source: "poison",
					mitigations: {
						blocked: !1,
						armourFactor: 1,
						defenseFactor: 1
					}
				}
			}), a.killed && (e.emit({
				type: "death",
				actor: n.id,
				payload: {}
			}), e.dropScheduleEntries(n.id));
			let o = (t.duration ?? 0) - 1;
			o <= 0 ? (e.removeStatus(n.id, "poison"), e.emit({
				type: "status:expired",
				actor: n.id,
				payload: { statusId: "poison" }
			})) : e.patchStatus(n.id, "poison", { duration: o });
		} else if (t.id === "stun") {
			let r = (t.duration ?? 0) - 1;
			r <= 0 ? (e.removeStatus(n.id, "stun"), e.emit({
				type: "status:expired",
				actor: n.id,
				payload: { statusId: "stun" }
			})) : e.patchStatus(n.id, "stun", { duration: r });
		}
	}
	for (let t of e.decrementStatModifiers(n.id)) e.emit({
		type: "stat:expired",
		actor: n.id,
		payload: {
			stat: t.stat,
			amount: t.amount
		}
	});
}, U = [
	"attacker",
	"target",
	"self"
], St = [
	"lt",
	"lte",
	"gt",
	"gte",
	"eq"
], Ct = ["ffa", "teams"], wt = [
	"blunt",
	"sharp",
	"true"
], Tt = ["weapon-1", "weapon-2"], Et = [
	"head",
	"body",
	"hands",
	"feet",
	"shield"
], Dt = [
	"weapon-1",
	"weapon-2",
	"shield"
], Ot = 2, kt = 2, At = [
	"always",
	"never",
	"stat",
	"has-status",
	"has-gear",
	"mode",
	"chance",
	"all",
	"any",
	"not"
], jt = [
	"strike",
	"damage-flat",
	"heal",
	"apply-status",
	"remove-status",
	"break-equipment",
	"modify-stat",
	"emit"
], W = (e) => typeof e == "object" && !!e && !Array.isArray(e) && (Object.getPrototypeOf(e) === Object.prototype || Object.getPrototypeOf(e) === null), G = (e) => typeof e == "string", Mt = (e) => typeof e == "number" && Number.isFinite(e), Nt = (e) => Mt(e) && Number.isInteger(e), Pt = (e) => e.includes("/"), Ft = (e) => `${e}: must match /^[a-z0-9][a-z0-9-]*$/`, It = (e, t) => `${e}: must be one of ${t.map((e) => typeof e == "string" ? `'${e}'` : String(e)).join(", ")}`, K = (e) => `${e}: expected a plain object`, Lt = (e) => `${e}: required`, Rt = (e, t, n) => n === void 0 ? `${e}: must be a finite number >= ${t}` : `${e}: must be a finite number between ${t} and ${n}`, zt = (e, t, n) => n === void 0 ? `${e}: must be an integer >= ${t}` : `${e}: must be an integer between ${t} and ${n}`, q = (e, t, n, r = !1) => {
	r && n === void 0 || G(n) || e.push(`${t}: must be a string`);
}, J = (e, t, n, r, i, a = !1) => {
	if (a && n === void 0) return;
	let o = i === void 0 ? Infinity : i;
	(!Mt(n) || n < r || n > o) && e.push(Rt(t, r, i));
}, Y = (e, t, n, r, i, a = !1) => {
	if (a && n === void 0) return;
	let o = i === void 0 ? Infinity : i;
	(!Nt(n) || n < r || n > o) && e.push(zt(t, r, i));
}, X = (e, t, n, r, i = !1) => {
	i && n === void 0 || r.includes(n) || e.push(It(t, r));
}, Z = (e, t, n) => {
	F(n) || e.push(Ft(t));
}, Bt = (e, n, r, i, a) => {
	if (i > 16) {
		e.push(`${n}: condition nesting exceeds depth 16`);
		return;
	}
	if (!W(r)) {
		e.push(K(n));
		return;
	}
	let c = r.type;
	if (!G(c)) {
		e.push(`${n}.type: must be a string`);
		return;
	}
	if (!At.includes(c)) {
		if (Pt(c)) {
			let t = a?.vocab?.conditions;
			t && !t.includes(c) && e.push(`${n}.type: unknown condition type '${c}' (no loaded plugin registers it)`);
			return;
		}
		e.push(`${n}.type: unknown condition type '${c}'`);
		return;
	}
	switch (c) {
		case "always":
		case "never": break;
		case "stat":
			X(e, `${n}.ref`, r.ref, U), X(e, `${n}.stat`, r.stat, t), X(e, `${n}.op`, r.op, St), Mt(r.value) || e.push(`${n}.value: must be a finite number`);
			break;
		case "has-status":
			X(e, `${n}.ref`, r.ref, U), Z(e, `${n}.status`, r.status);
			break;
		case "has-gear":
			X(e, `${n}.ref`, r.ref, U), X(e, `${n}.kind`, r.kind, o, !0), X(e, `${n}.slot`, r.slot, s, !0);
			break;
		case "mode":
			X(e, `${n}.is`, r.is, Ct);
			break;
		case "chance":
			J(e, `${n}.p`, r.p, 0, 1);
			break;
		case "all":
		case "any":
			Vt(e, `${n}.of`, r.of, i, a);
			break;
		case "not":
			Bt(e, `${n}.of`, r.of, i + 1, a);
			break;
		default: break;
	}
}, Vt = (e, t, n, r, i) => {
	if (!Array.isArray(n)) {
		e.push(`${t}: must be an array of at most 32 conditions`);
		return;
	}
	if (n.length > 32) {
		e.push(`${t}: must be an array of at most 32 conditions`);
		return;
	}
	n.forEach((n, a) => {
		Bt(e, `${t}[${a}]`, n, r + 1, i);
	});
}, Ht = (e, n, r, i) => {
	if (!W(r)) {
		e.push(K(n));
		return;
	}
	let a = r.type;
	if (!G(a)) {
		e.push(`${n}.type: must be a string`);
		return;
	}
	if (!jt.includes(a)) {
		if (Pt(a)) {
			let t = i?.vocab?.effects;
			t && !t.includes(a) && e.push(`${n}.type: unknown effect type '${a}' (no loaded plugin registers it)`);
			return;
		}
		e.push(`${n}.type: unknown effect type '${a}'`);
		return;
	}
	switch (a) {
		case "strike": break;
		case "damage-flat":
			X(e, `${n}.target`, r.target, U), J(e, `${n}.amount`, r.amount, 0, void 0), X(e, `${n}.damageType`, r.damageType, wt, !0);
			break;
		case "heal":
			X(e, `${n}.target`, r.target, U), J(e, `${n}.amount`, r.amount, 0, void 0);
			break;
		case "apply-status":
			X(e, `${n}.target`, r.target, U), Z(e, `${n}.status`, r.status), Y(e, `${n}.stacks`, r.stacks, 1, 9, !0), Y(e, `${n}.duration`, r.duration, 1, void 0, !0), Y(e, `${n}.potency`, r.potency, 1, void 0, !0);
			break;
		case "remove-status":
			X(e, `${n}.target`, r.target, U), Z(e, `${n}.status`, r.status);
			break;
		case "break-equipment":
			X(e, `${n}.target`, r.target, U), X(e, `${n}.slot`, r.slot, s, !0);
			break;
		case "modify-stat":
			X(e, `${n}.target`, r.target, U), X(e, `${n}.stat`, r.stat, t), Mt(r.amount) || e.push(`${n}.amount: must be a finite number`), Y(e, `${n}.duration`, r.duration, 0, void 0, !0);
			break;
		case "emit":
			q(e, `${n}.message`, r.message);
			break;
		default: break;
	}
}, Ut = (e, t, n, r, i = !0) => {
	if (n === void 0) {
		i && e.push(Lt(t));
		return;
	}
	if (!Array.isArray(n) || n.length > 32) {
		e.push(`${t}: must be an array of at most 32 effects`);
		return;
	}
	n.forEach((n, i) => {
		Ht(e, `${t}[${i}]`, n, r);
	});
}, Wt = (e, t) => {
	if (t === void 0) return;
	if (!Array.isArray(t)) {
		e.push("catalogs.gear: must be an array");
		return;
	}
	let n = /* @__PURE__ */ new Map();
	H.forEach((e) => n.set(e.id, { ...e })), t.forEach((t, r) => {
		let i = `catalogs.gear[${r}]`;
		if (!W(t)) {
			e.push(K(i));
			return;
		}
		Z(e, `${i}.id`, t.id);
		let c = G(t.id) ? t.id : void 0, l = c !== void 0 && n.has(c), u = (e) => t[e] !== void 0;
		if ([
			"kind",
			"slot",
			"handedness",
			"type",
			"damage",
			"blunt",
			"sharp",
			"durability"
		].forEach((t) => {
			!l && !u(t) && e.push(Lt(`${i}.${t}`));
		}), X(e, `${i}.kind`, t.kind, o, !0), X(e, `${i}.slot`, t.slot, s, !0), X(e, `${i}.handedness`, t.handedness, [
			0,
			1,
			2
		], !0), X(e, `${i}.type`, t.type, a, !0), J(e, `${i}.damage`, t.damage, 0, te, !0), J(e, `${i}.blunt`, t.blunt, 0, 1, !0), J(e, `${i}.sharp`, t.sharp, 0, 1, !0), Y(e, `${i}.durability`, t.durability, 1, S, !0), c !== void 0) {
			let r = { ...n.get(c) ?? {} };
			Object.entries(t).forEach(([e, t]) => {
				t !== void 0 && (r[e] = t);
			}), n.set(c, r);
			let a = r.kind, o = r.slot, s = r.handedness;
			a === "weapon" && G(o) && !Tt.includes(o) && e.push(`${i}.slot: weapon gear must use 'weapon-1' or 'weapon-2'`), a === "armour" && G(o) && !Et.includes(o) && e.push(`${i}.slot: armour gear must use 'head', 'body', 'hands', 'feet' or 'shield'`), a === "armour" && o === "shield" && s !== 1 && e.push(`${i}.handedness: shield gear must have handedness 1`), a === "armour" && G(o) && (o === "head" || o === "body" || o === "hands" || o === "feet") && s !== 0 && e.push(`${i}.handedness: armour gear in slot '${o}' must have handedness 0`);
		}
	});
}, Gt = (e, t, n) => {
	if (t === void 0) return;
	if (!Array.isArray(t)) {
		e.push("catalogs.abilities: must be an array");
		return;
	}
	let r = /* @__PURE__ */ new Set();
	t.forEach((t, i) => {
		let a = `catalogs.abilities[${i}]`;
		if (!W(t)) {
			e.push(K(a));
			return;
		}
		Z(e, `${a}.id`, t.id);
		let o = G(t.id) ? t.id : void 0, s = o !== void 0 && !r.has(o);
		o !== void 0 && r.add(o), q(e, `${a}.name`, t.name, !0), J(e, `${a}.cost`, t.cost, ee, 10, !0), Y(e, `${a}.cooldown`, t.cooldown, 0, void 0, !0), t.conditions !== void 0 && Bt(e, `${a}.conditions`, t.conditions, 1, n), Ut(e, `${a}.effects`, t.effects, n, s);
	});
}, Kt = (e, t, n) => {
	if (!W(n)) {
		e.push(K(t));
		return;
	}
	Y(e, `${t}.health`, n.health, 1, g), J(e, `${t}.strength`, n.strength, 0, _), J(e, `${t}.speed`, n.speed, v, 100), J(e, `${t}.defense`, n.defense, 0, y, !0), J(e, `${t}.precision`, n.precision, 0, b, !0), J(e, `${t}.evasion`, n.evasion, 0, x, !0);
}, qt = (e, t, n) => {
	if (n !== void 0) {
		if (!Array.isArray(n)) {
			e.push(`${t}: must be an array`);
			return;
		}
		n.forEach((n, r) => {
			let i = `${t}[${r}]`;
			if (!W(n)) {
				e.push(K(i));
				return;
			}
			Z(e, `${i}.id`, n.id), Y(e, `${i}.stacks`, n.stacks, 1, 9, !0), Y(e, `${i}.duration`, n.duration, 1, void 0, !0), Y(e, `${i}.potency`, n.potency, 1, void 0, !0);
		});
	}
}, Jt = (e, t, n, r) => {
	if (n === void 0) return;
	if (!W(n)) {
		e.push(K(t));
		return;
	}
	let i = [];
	["weapons", "armour"].forEach((a) => {
		let o = n[a];
		if (o === void 0) return;
		let c = `${t}.${a}`;
		if (!Array.isArray(o)) {
			e.push(`${c}: must be an array`);
			return;
		}
		o.forEach((t, n) => {
			let a = `${c}[${n}]`;
			if (!W(t)) {
				e.push(K(a));
				return;
			}
			q(e, `${a}.id`, t.id), X(e, `${a}.slot`, t.slot, s), Y(e, `${a}.durability`, t.durability, 1, S, !0);
			let o = G(t.id) ? t.id : void 0, l = G(t.slot) ? t.slot : void 0, u = o === void 0 ? void 0 : r.get(o);
			o !== void 0 && !u && e.push(`${a}.id: unknown gear id '${o}'`);
			let d;
			u && (u.kind === "weapon" && l !== void 0 && !Tt.includes(l) && e.push(`${a}.slot: gear '${o}' is a weapon and must go in 'weapon-1' or 'weapon-2'`), u.kind === "armour" && l !== void 0 && l !== u.slot && e.push(`${a}.slot: gear '${o}' occupies slot '${u.slot}', not '${l}'`), d = typeof u.handedness == "number" ? u.handedness : void 0), i.push({
				slot: l,
				gearId: o,
				handedness: d
			});
		});
	});
	let a = /* @__PURE__ */ new Map();
	i.forEach((e) => {
		if (e.slot === void 0) return;
		let t = a.get(e.slot) ?? [];
		t.push(e.gearId ?? "?"), a.set(e.slot, t);
	}), a.forEach((n, r) => {
		n.length > 1 && e.push(`${t}: slot '${r}' occupied by both '${n[0]}' and '${n[1]}'`);
	});
	let o = 0;
	i.forEach((e) => {
		e.slot !== void 0 && Dt.includes(e.slot) && (o += e.handedness ?? 0);
	}), o > Ot && e.push(`${t}: hands budget exceeded (${o} > ${Ot})`);
	let c = i.find((e) => e.handedness === kt && (e.slot === "weapon-1" || e.slot === "weapon-2"));
	c !== void 0 && c.gearId !== void 0 && i.some((e) => e !== c && (e.slot === "weapon-2" || e.slot === "shield")) && e.push(`${t}: two-handed gear '${c.gearId}' forbids 'weapon-2' and 'shield' occupants`);
}, Yt = (e, t, n, r, i) => {
	if (!W(n)) {
		e.push(K(t));
		return;
	}
	Z(e, `${t}.id`, n.id), q(e, `${t}.name`, n.name, !0), Kt(e, `${t}.stats`, n.stats), qt(e, `${t}.statuses`, n.statuses), Jt(e, `${t}.equipment`, n.equipment, r), n.abilities !== void 0 && (Array.isArray(n.abilities) ? n.abilities.forEach((n, r) => {
		let a = `${t}.abilities[${r}]`;
		Z(e, a, n), G(n) && !i.has(n) && e.push(`${a}: unknown ability id '${n}'`);
	}) : e.push(`${t}.abilities: must be an array`)), n.statusResistances !== void 0 && (W(n.statusResistances) ? Object.entries(n.statusResistances).forEach(([n, r]) => {
		F(n) || e.push(`${t}.statusResistances['${n}']: key must match /^[a-z0-9][a-z0-9-]*$/`), J(e, `${t}.statusResistances['${n}']`, r, 0, 1);
	}) : e.push(K(`${t}.statusResistances`)));
}, Xt = (e, t, n, r) => {
	if (t === "ffa") {
		n !== void 0 && (!Array.isArray(n) || n.length > 0) && e.push("teams: ffa mode must not declare teams"), r.forEach((t, n) => {
			t.team !== void 0 && e.push(`entities[${n}].team: ffa mode forbids entity.team`);
		});
		return;
	}
	if (t !== "teams") return;
	if (!Array.isArray(n)) {
		e.push("teams: teams mode requires at least 2 teams");
		return;
	}
	n.length < 2 && e.push("teams: teams mode requires at least 2 teams");
	let i = /* @__PURE__ */ new Set();
	r.forEach((e) => {
		F(e.id) && i.add(e.id);
	});
	let a = /* @__PURE__ */ new Set(), o = /* @__PURE__ */ new Map();
	n.forEach((t, n) => {
		let r = `teams[${n}]`;
		if (!W(t)) {
			e.push(K(r));
			return;
		}
		Z(e, `${r}.id`, t.id), q(e, `${r}.name`, t.name, !0);
		let s = G(t.id) ? t.id : void 0;
		if (s !== void 0 && (a.has(s) && e.push(`${r}.id: duplicate team id '${s}'`), a.add(s)), t.members === void 0 || !Array.isArray(t.members)) {
			e.push(`${r}.members: must be an array`);
			return;
		}
		let c = [], l = /* @__PURE__ */ new Set();
		t.members.forEach((t, n) => {
			let a = `${r}.members[${n}]`;
			if (!G(t)) {
				e.push(`${a}: must be a string`);
				return;
			}
			i.has(t) || e.push(`${a}: unknown entity id '${t}'`), l.has(t) && e.push(`${a}: duplicate member id '${t}'`), l.add(t), c.push(t);
		}), s !== void 0 && o.set(s, c);
	}), r.forEach((t, n) => {
		let r = `entities[${n}].team`, i = G(t.id) ? t.id : `#${n}`;
		if (t.team === void 0) {
			e.push(`${r}: teams mode requires entity '${i}' to declare a team`);
			return;
		}
		if (!G(t.team)) {
			e.push(`${r}: must be a string`);
			return;
		}
		if (!a.has(t.team)) {
			e.push(`${r}: unknown team id '${t.team}'`);
			return;
		}
		let s = o.get(t.team) ?? [];
		G(t.id) && !s.includes(t.id) && e.push(`${r}: team '${t.team}' does not list entity '${i}' in members`);
	}), n.forEach((t, n) => {
		!W(t) || !G(t.id) || !Array.isArray(t.members) || t.members.forEach((i, a) => {
			if (!G(i)) return;
			let o = r.find((e) => e.id === i);
			o !== void 0 && G(o.team) && o.team !== t.id && e.push(`teams[${n}].members[${a}]: entity '${i}' declares team '${o.team}' not '${t.id}'`);
		});
	});
}, Zt = (e, t) => {
	if (t !== void 0) {
		if (!W(t)) {
			e.push(K("startingConditions"));
			return;
		}
		if (Y(e, "startingConditions.seed", t.seed, 0, f, !0), t.config !== void 0) if (!W(t.config)) e.push(K("startingConditions.config"));
		else {
			let n = t.config;
			Y(e, "startingConditions.config.maxSteps", n.maxSteps, 1, p, !0), Y(e, "startingConditions.config.maxCascade", n.maxCascade, 1, m, !0), Y(e, "startingConditions.config.maxLogEvents", n.maxLogEvents, 1, h, !0);
		}
	}
}, Qt = (e, t, n) => {
	if (t === void 0) return;
	if (!W(t)) {
		e.push(K("rules"));
		return;
	}
	let r = t.contributions;
	if (r === void 0) return;
	if (!Array.isArray(r)) {
		e.push("rules.contributions: must be an array");
		return;
	}
	let a = /* @__PURE__ */ new Set();
	r.forEach((t, r) => {
		let o = `rules.contributions[${r}]`;
		if (!W(t)) {
			e.push(K(o));
			return;
		}
		Z(e, `${o}.id`, t.id), G(t.id) && (a.has(t.id) && e.push(`${o}.id: duplicate rule id '${t.id}'`), a.add(t.id)), X(e, `${o}.hook`, t.hook, i), t.when !== void 0 && Bt(e, `${o}.when`, t.when, 1, n), Ut(e, `${o}.effects`, t.effects, n, !0);
	});
}, $t = (e, t) => {
	let n = [];
	if (!W(e)) return n.push("definition: expected a plain object"), {
		valid: !1,
		errors: n
	};
	e.schemaVersion !== 1 && n.push("schemaVersion: must be 1"), q(n, "name", e.name, !0), X(n, "mode", e.mode, Ct);
	let r = [];
	!Array.isArray(e.entities) || e.entities.length < 2 ? (n.push("entities: must be an array of at least 2 entities"), Array.isArray(e.entities) && r.push(...e.entities)) : r.push(...e.entities);
	let i = e.catalogs !== void 0 && W(e.catalogs) ? e.catalogs : void 0;
	e.catalogs !== void 0 && i === void 0 && n.push(K("catalogs"));
	let a = ut(H, i && Array.isArray(i.gear) ? i.gear : void 0), o = new Map(a.map((e) => [e.id, e])), s = new Set(i && Array.isArray(i.abilities) ? i.abilities.filter(W).map((e) => e.id).filter(G) : []), c = /* @__PURE__ */ new Set();
	r.forEach((e, t) => {
		if (Yt(n, `entities[${t}]`, e, o, s), W(e) && F(e.id)) {
			let r = e.id;
			c.has(r) && n.push(`entities[${t}].id: duplicate entity id '${r}'`), c.add(r);
		}
	});
	let l = r.filter(W);
	return Xt(n, e.mode, e.teams, l), W(e.catalogs) && (Wt(n, e.catalogs.gear), Gt(n, e.catalogs.abilities, t)), Zt(n, e.startingConditions), Qt(n, e.rules, t), {
		valid: n.length === 0,
		errors: n
	};
}, Q = class extends Error {
	pluginId;
	hook;
	constructor(e, t, n) {
		super(e), this.name = "CombatFault", this.pluginId = t, this.hook = n;
	}
}, $ = (e) => typeof e == "object" && !!e && !Array.isArray(e), en = (e) => e instanceof Error ? e.message : String(e), tn = (e) => {
	let t = e.state, n = 0, r = 0, i, o, s, c, l, u = (e) => {
		let n = j(t, e);
		return O(n.baseStats, n.statModifiers).speed;
	}, d = (e) => {
		let n = j(t, e);
		return {
			effectiveSpeed: O(n.baseStats, n.statModifiers).speed,
			order: n.order
		};
	}, f = (n) => {
		if (r += 1, r > e.config.maxCascade) throw new Q(`maxCascade exceeded: more than ${e.config.maxCascade} events in one step`, void 0, i);
		e.log.emit(n, t.step, t.virtualTime);
	}, p = (e, n) => {
		let r = e ?? s ?? t.entities[0]?.id;
		if (!r) throw new Q("hook invoked with no entities");
		let i = { actor: k(j(t, r)) }, a = n === void 0 ? c : n;
		return a !== void 0 && (i.target = k(j(t, a))), i;
	}, m = (r, i, a) => ({
		rng: e.rng,
		emit: f,
		step: t.step,
		time: t.virtualTime,
		hook: r,
		depth: n,
		refs: p(i, a)
	}), h = (e, t, n) => {
		let r = i, a = o;
		i = e, o = t;
		try {
			return n();
		} catch (n) {
			throw n instanceof Q && (n.hook !== void 0 || n.pluginId !== void 0) ? n : new Q(en(n), t, e);
		} finally {
			i = r, o = a;
		}
	}, g = (n, r, i, a, o) => {
		let s = e.registry.single(n);
		if (s) return h(n, e.registry.singleOwner(n), () => i(s(A(t), m(n, a, o), r)));
	}, _ = (e, t, n) => {
		if (typeof e != "number" || !Number.isFinite(e)) throw new Q(`invalid ${t} result: '${n}' must be a finite number`, o, i);
		return e;
	}, v = (e, t, n) => {
		if (typeof e != "boolean") throw new Q(`invalid ${t} result: '${n}' must be a boolean`, o, i);
		return e;
	}, y = (e) => {
		if (!$(e)) throw new Q("invalid action:select result: expected an object", o, i);
		let t = e.kind;
		if (t !== "attack" && t !== "ability" && t !== "wait" && t !== "skip") throw new Q(`invalid action:select result: unknown kind '${String(t)}'`, o, i);
		let n = { kind: t };
		if (e.abilityId !== void 0) {
			if (typeof e.abilityId != "string" || e.abilityId === "") throw new Q("invalid action:select result: abilityId must be a non-empty string", o, i);
			n.abilityId = e.abilityId;
		}
		if (e.reason !== void 0) {
			if (typeof e.reason != "string") throw new Q("invalid action:select result: reason must be a string", o, i);
			n.reason = e.reason;
		}
		if (t === "ability" && n.abilityId === void 0) throw new Q("invalid action:select result: kind 'ability' requires abilityId", o, i);
		return n;
	}, b = (e) => {
		if (e === null) return null;
		if (typeof e != "string") throw new Q("invalid target:select result: expected entityId string or null", o, i);
		let n = t.entities.find((t) => t.id === e), r = s === void 0 ? void 0 : t.entities.find((e) => e.id === s);
		if (!(n !== void 0 && n.living && e !== s && (t.mode !== "teams" || n.team !== r?.team))) throw new Q(`invalid target:select result: '${e}' is not a living enemy`, o, i);
		return e;
	}, x = (e) => {
		if (!$(e)) throw new Q("invalid attack:dodge result: expected an object", o, i);
		return { dodged: v(e.dodged, "attack:dodge", "dodged") };
	}, ee = (e) => {
		if (!$(e)) throw new Q("invalid attack:crit result: expected an object", o, i);
		return { crit: v(e.crit, "attack:crit", "crit") };
	}, te = (e) => {
		if (!$(e)) throw new Q("invalid damage:base result: expected an object", o, i);
		let t = _(e.amount, "damage:base", "amount");
		if (t < 0) throw new Q("invalid damage:base result: amount must be >= 0", o, i);
		if (!a.includes(e.damageType)) throw new Q(`invalid damage:base result: damageType '${String(e.damageType)}'`, o, i);
		return {
			amount: t,
			damageType: e.damageType
		};
	}, S = (e) => {
		if (!$(e)) throw new Q("invalid damage:mitigate result: expected an object", o, i);
		let t = _(e.amount, "damage:mitigate", "amount");
		if (t < 0) throw new Q("invalid damage:mitigate result: amount must be >= 0", o, i);
		return {
			amount: t,
			blocked: v(e.blocked, "damage:mitigate", "blocked"),
			armourFactor: _(e.armourFactor, "damage:mitigate", "armourFactor"),
			defenseFactor: _(e.defenseFactor, "damage:mitigate", "defenseFactor")
		};
	}, C = (e) => {
		if (!Array.isArray(e)) throw new Q("invalid ability:execute result: expected an EffectDescriptor[]", o, i);
		return e;
	}, ne = (e) => {
		if (e == null) return null;
		if (!$(e)) throw new Q("invalid outcome:decide result: expected verdict object or null", o, i);
		let t = e.outcome;
		if (t !== "victory" && t !== "draw" && t !== "undecided" && t !== "fault") throw new Q(`invalid outcome:decide result: unknown outcome '${String(t)}'`, o, i);
		let n = { outcome: t };
		for (let t of [
			"winner",
			"reason",
			"error"
		]) {
			let r = e[t];
			if (r !== void 0) {
				if (typeof r != "string") throw new Q(`invalid outcome:decide result: '${t}' must be a string`, o, i);
				n[t] = r;
			}
		}
		return n;
	}, re = (e) => {
		let t = g("scheduler:interval", e, (e) => {
			if (typeof e != "number" || !Number.isFinite(e)) throw new Q("invalid scheduler:interval result: expected a finite number", o, i);
			return e;
		}, e.entityId) ?? V(e);
		return Math.max(1, Math.round(t));
	}, ie = (e) => g("scheduler:order", e, (t) => {
		if (typeof t != "string" || !e.candidates.some((e) => e.entityId === t)) throw new Q("invalid scheduler:order result: not a candidate entityId", o, i);
		return t;
	}) ?? et(e), w = (e) => e.equipment.find((e) => e.slot === "weapon-1") ?? e.equipment.find((e) => e.slot === "weapon-2"), oe = (t, n) => t.equipment.filter((t) => {
		if (!ce.includes(t.slot)) return !1;
		let r = e.gear(t.gearId);
		return r ? (n === "blunt" ? r.blunt : r.sharp) > 0 : !1;
	}), se = (e, n, r) => {
		n && (f({
			type: "death",
			actor: e,
			payload: r ? { killerId: r } : {}
		}), we(t, e));
	}, T = {
		strike: () => {
			let e = n + 1;
			if (e > 2) throw new Q("strike recursion depth exceeded (max 2)", o, i);
			ue(e);
		},
		damageFlat: (e, n, r) => {
			let i = he(t, e, n);
			f({
				type: "damage",
				actor: s,
				target: e,
				payload: {
					amount: i.applied,
					damageType: r ?? "true",
					source: "effect",
					crit: !1,
					mitigations: {
						blocked: !1,
						armourFactor: 1,
						defenseFactor: 1
					}
				}
			}), se(e, i.killed, s);
		},
		heal: (e, n) => {
			let r = ge(t, e, n);
			f({
				type: "heal",
				actor: s,
				target: e,
				payload: { amount: r.applied }
			});
		},
		applyStatus: (n, r, i, a, o) => {
			let s = e.resistances[n]?.[r] ?? 0, c = _e(t, n, r, {
				stacks: i,
				duration: a,
				potency: o,
				resistance: s
			});
			if (c.kind === "resisted") f({
				type: "status:resisted",
				actor: n,
				payload: { statusId: r }
			});
			else {
				let e = {
					statusId: r,
					stacks: c.status.stacks ?? 1,
					potency: c.status.potency ?? 1
				};
				c.status.duration !== void 0 && (e.duration = c.status.duration), f({
					type: "status:applied",
					actor: n,
					payload: e
				});
			}
		},
		removeStatus: (e, n) => {
			ve(t, e, n);
		},
		breakEquipment: (e, n) => {
			for (let r of Ce(t, e, n)) f({
				type: "gear:broken",
				actor: e,
				payload: {
					gearId: r.gearId,
					slot: r.slot
				}
			});
		},
		modifyStat: (e, n, r, i) => {
			let a = u(e), o = ye(t, e, n, r, i ?? 0);
			f({
				type: "stat:modified",
				actor: s,
				target: e,
				payload: {
					stat: n,
					amount: r,
					remainingTurns: o.remainingTurns
				}
			}), n === "speed" && e !== s && st(t.schedule, e, t.virtualTime, a, u(e), re);
		},
		emitMessage: (e) => {
			f({
				type: "message",
				actor: s,
				message: e
			});
		}
	}, E = (n, r, i) => ({
		view: A(t),
		ctx: m(n, r, i),
		vocab: e.registry.vocab,
		adapter: T
	}), D = (n, r) => {
		let i = e.registry.chain(n);
		for (let a = 0; a < i.length; a += 1) {
			let o = i[a], s = e.registry.chainOwner(n, a);
			h(n, s, () => {
				let e = o(A(t), m(n), r);
				if (e != null) {
					if (!Array.isArray(e)) throw new Q(`invalid chain result from '${n}' handler: expected void or EffectDescriptor[]`, s, n);
					qe(e, E(n));
				}
			});
		}
	}, le = {
		damageGear: (e, n, r) => xe(t, e, n, r),
		removeGear: (e, n) => Se(t, e, n),
		damageEntity: (e, n) => he(t, e, n),
		removeStatus: (e, n) => ve(t, e, n),
		patchStatus: (e, n, r) => {
			let i = j(t, e).statuses.find((e) => e.id === n);
			i && (r.stacks !== void 0 && (i.stacks = r.stacks), r.duration !== void 0 && (i.duration = r.duration));
		},
		decrementStatModifiers: (e) => be(t, e),
		dropScheduleEntries: (e) => {
			we(t, e);
		},
		emit: f
	};
	function ue(r) {
		let i = n;
		n = r;
		try {
			if (!s || !c) return;
			let n = k(j(t, s)), r = k(j(t, c)), i = w(n), a = {
				attacker: n,
				target: r,
				...i ? { weapon: i } : {}
			};
			if ((g("attack:dodge", a, x) ?? { dodged: !1 }).dodged) {
				f({
					type: "dodge",
					actor: r.id,
					target: n.id
				});
				return;
			}
			let o = g("attack:crit", a, ee) ?? { crit: !1 };
			o.crit && f({
				type: "crit",
				actor: n.id,
				target: r.id
			});
			let l = g("damage:base", a, te);
			if (l === void 0) throw new Q("no handler for damage:base (decision 8)", void 0, "damage:base");
			let u = g("damage:mitigate", {
				attacker: n,
				target: r,
				amount: o.crit ? l.amount * ae : l.amount,
				damageType: l.damageType
			}, S);
			if (u === void 0) throw new Q("no handler for damage:mitigate (decision 8)", void 0, "damage:mitigate");
			u.blocked && f({
				type: "block",
				actor: r.id,
				target: n.id
			});
			let d = oe(r, l.damageType), p = he(t, r.id, u.amount);
			f({
				type: "damage",
				actor: n.id,
				target: r.id,
				payload: {
					amount: u.amount,
					damageType: l.damageType,
					source: i ? "weapon" : "unarmed",
					...i ? { weaponId: i.gearId } : {},
					crit: o.crit,
					mitigations: {
						blocked: u.blocked,
						armourFactor: u.armourFactor,
						defenseFactor: u.defenseFactor
					}
				}
			}), se(r.id, p.killed, n.id), D("damage:post", {
				amount: u.amount,
				killed: p.killed,
				attacker: n,
				target: r,
				damageType: l.damageType
			});
			let m = {
				attacker: n,
				target: r,
				...i ? { weapon: i } : {},
				damageType: l.damageType,
				contributedArmour: d
			};
			e.builtinRules && bt(le, m), D("equipment:post", m);
		} finally {
			n = i;
		}
	}
	let de = {
		next: () => {
			throw new Q("outcome:decide handlers must not consume rng (pure observation, D5g)", o, "outcome:decide");
		},
		int: () => {
			throw new Q("outcome:decide handlers must not consume rng (pure observation, D5g)", o, "outcome:decide");
		},
		pick: () => {
			throw new Q("outcome:decide handlers must not consume rng (pure observation, D5g)", o, "outcome:decide");
		}
	}, pe = () => {
		throw new Q("outcome:decide handlers must not emit events (pure observation, D5g)", o, "outcome:decide");
	}, Te = () => {
		let n = e.registry.single("outcome:decide");
		return n ? h("outcome:decide", e.registry.singleOwner("outcome:decide"), () => {
			let r = {
				rng: de,
				emit: pe,
				step: t.step,
				time: t.virtualTime,
				hook: "outcome:decide",
				depth: 0,
				refs: p()
			}, i = {
				step: t.step,
				time: t.virtualTime,
				config: e.config
			};
			return ne(n(A(t), r, i));
		}) : null;
	}, Ee = (e) => {
		t.terminal = {
			...e,
			step: t.step
		};
		let n = { outcome: e.outcome };
		e.winner !== void 0 && (n.winner = e.winner), e.reason !== void 0 && (n.reason = e.reason), e.error !== void 0 && (n.error = e.error), f({
			type: "outcome",
			payload: n
		});
	}, De = () => {
		if (t.schedule.length === 0) return !1;
		let n = at(t.schedule, d, ie);
		if (!n) return !1;
		t.virtualTime = n.time, t.step += 1, s = n.entry.entityId, c = void 0, l = void 0;
		let r = j(t, s), a = O(r.baseStats, r.statModifiers).speed;
		f({
			type: "turn:start",
			actor: s
		});
		let u = g("action:select", { actor: k(r) }, (t) => {
			let n = y(t);
			if (n.kind === "ability" && !e.ability(n.abilityId)) throw new Q(`action:select returned unknown abilityId '${n.abilityId}'`, o, i);
			return n;
		}) ?? { kind: "wait" }, p = u.kind === "ability" ? e.ability(u.abilityId) : void 0, m = p ? p.cost ?? 1 : 1;
		ot(t.schedule, s, t.virtualTime, m, a, re);
		let h = u;
		if (u.kind === "attack" || u.kind === "ability") {
			let e = g("target:select", {
				actor: k(r),
				action: u
			}, b) ?? null;
			e === null ? h = {
				kind: "skip",
				reason: "no-target"
			} : c = e;
		}
		let _ = { kind: h.kind };
		if (h.kind === "ability" && h.abilityId && (_.abilityId = h.abilityId), h.reason !== void 0 && (_.reason = h.reason), f({
			type: "action",
			actor: s,
			payload: _
		}), h.kind === "attack" && c) {
			let e = k(j(t, s));
			D("attack:pre", {
				actor: e,
				target: k(j(t, c)),
				...w(e) ? { weapon: w(e) } : {}
			}), ue(1);
		} else if (h.kind === "ability" && p && c) {
			let e = g("ability:execute", {
				actor: k(j(t, s)),
				target: k(j(t, c)),
				ability: p
			}, C);
			if (e === void 0) throw new Q("no handler for ability:execute (decision 8)", void 0, "ability:execute");
			qe(e, E("ability:execute"));
			let n = p.cooldown ?? 0;
			n > 0 && (j(t, s).cooldowns[p.id] = n, l = p.id);
		}
		e.builtinRules && xt(le, { entity: k(j(t, s)) }), D("status:turn-end", { entity: k(j(t, s)) });
		let v = j(t, s).cooldowns;
		for (let e of Object.keys(v)) e !== l && v[e] > 0 && --v[e];
		f({
			type: "step:end",
			payload: {
				step: t.step,
				time: t.virtualTime
			}
		}), D("step:end", {
			step: t.step,
			time: t.virtualTime
		});
		let x = Te();
		return x && Ee(x), !0;
	}, Oe = (e) => me({
		schemaVersion: 1,
		definition: {
			schemaVersion: 1,
			mode: t.mode,
			entities: []
		},
		state: e,
		events: []
	}), ke = (r, a, u) => {
		let d = r instanceof Q ? r : new Q(en(r), o, i);
		t = Oe(a.snap), e.rng.restoreState(a.snap.rng), e.log.rollback(a.marker), s = void 0, c = void 0, n = 0, l = void 0;
		let f = a.snap.virtualTime, p = { error: d.message };
		d.pluginId !== void 0 && (p.pluginId = d.pluginId), d.hook !== void 0 && (p.hook = d.hook), e.log.emit({
			type: "fault",
			payload: p
		}, u, f), t.terminal = {
			outcome: "fault",
			step: u,
			reason: "fault",
			error: d.message
		}, e.log.emit({
			type: "outcome",
			payload: {
				outcome: "fault",
				reason: "fault",
				error: d.message
			}
		}, u, f), e.log.trim(u, f);
	};
	return {
		state: () => t,
		setState: (e) => {
			t = e;
		},
		armInitialSchedule: () => {
			t.schedule = tt(t.entities.filter((e) => e.living).map((e) => ({
				entityId: e.id,
				actionCost: 1,
				effectiveSpeed: O(e.baseStats, e.statModifiers).speed
			})), re);
		},
		decideAtStepZero: () => {
			let n = {
				snap: fe(t),
				marker: e.log.marker()
			};
			r = 0;
			try {
				let e = Te();
				e && Ee(e);
			} catch (e) {
				ke(e, n, n.snap.step);
			}
		},
		step: () => {
			if (t.terminal) return !0;
			let n = {
				snap: fe(t),
				marker: e.log.marker()
			};
			r = 0;
			try {
				return De() ? (t.rng = e.rng.exportState(), e.log.trim(t.step, t.virtualTime), !0) : !1;
			} catch (e) {
				return ke(e, n, n.snap.step + 1), !0;
			}
		},
		runtime: () => ({
			adapter: T,
			view: () => A(t)
		})
	};
}, nn = (e) => {
	let t = [], n = [];
	for (let r of e) if (!(r === void 0 || typeof r != "object" || typeof r.id != "string")) {
		if (r.vocab?.conditions) for (let e of Object.keys(r.vocab.conditions)) t.push(Fe(r.id, e));
		if (r.vocab?.effects) for (let e of Object.keys(r.vocab.effects)) n.push(Fe(r.id, e));
	}
	return {
		conditions: t,
		effects: n
	};
}, rn = (e, t) => {
	if (e === t) return !0;
	if (typeof e != "object" || typeof t != "object" || e === null || t === null) return !1;
	if (Array.isArray(e) || Array.isArray(t)) return !Array.isArray(e) || !Array.isArray(t) || e.length !== t.length ? !1 : e.every((e, n) => rn(e, t[n]));
	let n = e, r = t, i = Object.keys(n);
	return i.length === Object.keys(r).length ? i.every((e) => Object.prototype.hasOwnProperty.call(r, e) && rn(n[e], r[e])) : !1;
}, an = (e, t = {}) => {
	let n = E(e), r = ft(n), i = r.catalogs?.gear ?? H, a = new Map(i.map((e) => [e.id, e])), o = r.catalogs?.abilities ?? [], s = new Map(o.map((e) => [e.id, e])), l = t.plugins ?? [], u;
	for (let e of l) ht(e) && (u = e);
	let d = t.builtinRules !== !1 || u !== void 0, f = l.filter((e) => !ht(e)), p = $t(n, { vocab: nn([d ? yt() : void 0, ...f]) });
	if (!p.valid) throw new c(p.errors);
	let m = {
		maxSteps: r.startingConditions?.config?.maxSteps ?? 1e4,
		maxCascade: r.startingConditions?.config?.maxCascade ?? 1e3,
		maxLogEvents: r.startingConditions?.config?.maxLogEvents ?? 1e5
	}, h = r.startingConditions?.seed ?? 1, g = {};
	for (let e of r.entities) e.statusResistances && (g[e.id] = E(e.statusResistances));
	let _ = Oe(h), v = ke(m.maxLogEvents), y, b = $e({
		builtin: d ? yt({
			gear: i,
			abilities: o,
			vocab: {
				condition: (e) => y?.vocab.condition(e),
				effect: (e) => y?.vocab.effect(e)
			}
		}) : void 0,
		plugins: f,
		rules: r.rules?.contributions,
		runtime: () => S.runtime()
	});
	y = b;
	let x = (e) => (e ?? []).map((e) => ({
		gearId: e.id,
		slot: e.slot,
		durability: e.durability ?? a.get(e.id).durability
	})), ee = () => r.entities.map((e, t) => ue({
		id: e.id,
		name: e.name,
		team: e.team,
		order: t,
		stats: e.stats,
		statuses: e.statuses,
		equipment: [...x(e.equipment?.weapons), ...x(e.equipment?.armour)],
		cooldowns: Object.fromEntries((e.abilities ?? []).map((e) => [e, 0]))
	})), te = () => (_.restoreState({
		seed: h >>> 0,
		state: h >>> 0,
		draws: 0
	}), de({
		mode: r.mode,
		entities: ee(),
		rng: _.exportState(),
		schedule: [],
		step: 0,
		virtualTime: 0,
		terminal: null
	})), S;
	if (t.restore !== void 0) {
		let e = t.restore;
		if (!rn(e.definition, r)) throw new c(["restore: snapshot definition does not match the resolved battle definition"]);
		if (!Array.isArray(e.events)) throw new c(["restore: snapshot.events must be an array"]);
		let n;
		try {
			n = me(e);
		} catch (e) {
			throw new c([e instanceof Error ? e.message : String(e)]);
		}
		S = tn({
			state: n,
			registry: b,
			rng: _,
			log: v,
			config: m,
			gear: (e) => a.get(e),
			ability: (e) => s.get(e),
			resistances: g,
			builtinRules: d
		}), _.restoreState(n.rng), v.restore(e.events);
	} else S = tn({
		state: te(),
		registry: b,
		rng: _,
		log: v,
		config: m,
		gear: (e) => a.get(e),
		ability: (e) => s.get(e),
		resistances: g,
		builtinRules: d
	}), S.armInitialSchedule(), v.emit({
		type: "battle:start",
		payload: {
			seed: h,
			mode: r.mode
		}
	}, 0, 0), S.decideAtStepZero(), v.trim(0, 0);
	let C = {
		definition: r,
		snapshot: () => pe(S.state(), r, v.all()),
		events: () => E(v.all()),
		step: () => (S.state().terminal === null && S.step(), C.snapshot()),
		run: (e) => {
			let t = 0;
			for (; S.state().terminal === null && (e === void 0 || t < e);) {
				let e = S.step();
				if (t += 1, !e) break;
			}
			return C.snapshot();
		},
		reset: () => (S.setState(te()), S.armInitialSchedule(), v.clear(), v.emit({
			type: "battle:start",
			payload: {
				seed: h,
				mode: r.mode
			}
		}, 0, 0), S.decideAtStepZero(), v.trim(0, 0), C.snapshot()),
		isTerminal: () => S.state().terminal !== null,
		outcome: () => E(S.state().terminal)
	};
	return Object.defineProperty(C, "definition", {
		get: () => E(r),
		enumerable: !0,
		configurable: !1
	}), C;
};
//#endregion
export { e as COMBAT_SCHEMA_VERSION, l as CombatPluginError, c as CombatValidationError, a as DAMAGE_TYPES, o as GEAR_KINDS, n as HOOK_IDS, s as SLOTS, t as STAT_KEYS, lt as createGearCatalog, an as createSimulation, H as defaultGearSeed, yt as defaultRules, Ne as renderEventText, $t as validateBattleDefinition };

//# sourceMappingURL=userfiction-combat.mjs.map