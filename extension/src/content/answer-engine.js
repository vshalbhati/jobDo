/* global window */
// Turns a question label into a value for whatever widget is holding it.
// Order of precedence: your rule list, then facts from the resume profile,
// then a narrow set of safe inferences. Anything it can't answer is reported
// as "unknown" rather than guessed, so the run can stop instead of submitting
// a form with junk in it.
window.LEA = window.LEA || {};

(function (LEA) {
  const YES = ['yes', 'y', 'true', 'i do', 'i am', 'i have', 'agree'];
  const NO = ['no', 'n', 'false', 'i do not', "i don't", 'i am not', 'disagree'];
  const DECLINE = ['decline', 'prefer not', 'do not wish', "don't wish", 'not wish to answer', 'choose not', 'i don’t wish'];

  function norm(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\*/g, '').trim();
  }

  // "How many years of experience do you have with Kubernetes?" -> kubernetes
  function skillFromYearsQuestion(label, skills) {
    const m = label.match(/years?[^.?]*?\b(?:with|in|of|using|on)\s+([^.?,]{2,60})/i);
    const phrase = m ? m[1] : label;
    const names = Object.keys(skills || {});
    // Longest skill name wins: "spring boot" should beat "spring".
    let best = '';
    for (const s of names) {
      if (phrase.toLowerCase().includes(s.toLowerCase()) && s.length > best.length) best = s;
    }
    return best;
  }

  function profileFallback(label, profile) {
    const l = norm(label);
    const p = profile || {};
    const pairs = [
      [/first name|given name/, p.firstName],
      [/last name|surname|family name/, p.lastName],
      [/full name|your name/, [p.firstName, p.lastName].filter(Boolean).join(' ')],
      [/e-?mail/, p.email],
      [/phone|mobile|contact number/, p.phone],
      [/country code/, ''],
      [/\bcity\b|current location|where are you|\baddress\b/, p.city],
      [/\bcountry\b/, p.country],
      [/linkedin/, p.linkedin],
      [/github/, p.github],
      [/portfolio|personal website|website|blog/, p.website],
      [/expected (salary|ctc|compensation)|desired (salary|compensation)|salary expectation/, p.expectedSalary],
      [/current (salary|ctc|compensation)/, p.currentSalary],
      [/current (employer|company)|present employer|company name/, p.currentCompany],
      [/current (job )?title|current role|current position|present designation/, p.currentTitle],
      [/notice period|how soon can you|availability to (start|join)/, p.noticePeriodDays],
      [/highest level of education|education level|degree/, p.education]
    ];
    for (const [re, val] of pairs) {
      if (re.test(l) && val !== undefined && val !== null && String(val) !== '') return String(val);
    }
    if (/years?|how many|experience/.test(l)) {
      const skill = skillFromYearsQuestion(label, p.skills);
      if (skill && p.skills[skill]) return String(p.skills[skill]);
      return String(p.defaultYears ?? 0);
    }
    return '';
  }

  function matchRule(label, rules) {
    const l = norm(label);
    for (const r of rules || []) {
      if (!r.enabled || !r.pattern) continue;
      let re;
      try { re = new RegExp(r.pattern, 'i'); } catch { continue; }
      if (re.test(l)) return r;
    }
    return null;
  }

  // Given the answer as text, choose among the widget's actual options.
  function pickOption(answer, options) {
    if (!options || !options.length) return null;
    const a = norm(answer);
    if (!a) return null;
    const cand = options.map((o) => ({ ...o, n: norm(o.label) }))
      .filter((o) => o.n && !/^(select an option|choose|please select|--)/.test(o.n));

    let hit = cand.find((o) => o.n === a);
    if (hit) return hit;

    const isYes = YES.includes(a);
    const isNo = NO.includes(a);
    if (isYes || isNo) {
      const words = isYes ? YES : NO;
      // "No" must not match "Not sure" / "None", so compare whole words.
      hit = cand.find((o) => words.includes(o.n));
      if (hit) return hit;
      hit = cand.find((o) => words.some((w) => new RegExp('^' + w + '\\b').test(o.n)));
      if (hit) return hit;
    }

    if (DECLINE.some((d) => a.includes(d))) {
      hit = cand.find((o) => DECLINE.some((d) => o.n.includes(d)));
      if (hit) return hit;
    }

    const num = a.match(/\d+/);
    if (num) {
      hit = cand.find((o) => o.n.replace(/\D/g, '') === num[0]);
      if (hit) return hit;
    }

    hit = cand.find((o) => o.n.includes(a)) || cand.find((o) => a.includes(o.n));
    return hit || null;
  }

  // kind: 'text' | 'number' | 'textarea' | 'select' | 'radio' | 'checkbox'
  // options: [{ value, label }] for select/radio
  function resolve(label, kind, options, cfg) {
    const profile = (cfg && cfg.profile) || {};
    const rules = (cfg && cfg.answers && cfg.answers.rules) || [];

    const rule = matchRule(label, rules);
    let answer = rule && rule.answer ? String(rule.answer) : '';
    let source = answer ? 'rule:' + rule.pattern.slice(0, 30) : '';

    if (!answer) {
      answer = profileFallback(label, profile);
      if (answer) source = 'profile';
    }
    if (!answer && rule) {
      // A rule matched but has no answer filled in and the profile has nothing
      // either - that is exactly the case worth surfacing to the user.
      return { unknown: true, label, kind, options, hint: rule.pattern };
    }
    if (!answer) return { unknown: true, label, kind, options };

    if (kind === 'select' || kind === 'radio') {
      const opt = pickOption(answer, options);
      if (!opt) return { unknown: true, label, kind, options, tried: answer };
      return { value: opt.value, optionLabel: opt.label, source, kind };
    }

    if (kind === 'checkbox') {
      const on = YES.includes(norm(answer)) || norm(answer) === 'on';
      return { value: on, source, kind };
    }

    if (kind === 'number') {
      const n = String(answer).match(/\d+(\.\d+)?/);
      if (!n) return { unknown: true, label, kind, tried: answer };
      return { value: n[0], source, kind };
    }

    return { value: answer, source, kind };
  }

  LEA.answers = { resolve, pickOption, profileFallback, norm };
})(window.LEA);
