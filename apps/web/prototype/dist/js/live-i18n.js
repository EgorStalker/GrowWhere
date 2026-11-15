// Ukrainian first. A later English dictionary can use these same keys.
export const locale = 'uk-UA';
export const copy = {
  brandTag:'Ваша земля. Зрозумілий вибір.', title:'Що посадити. Де виростити.',
  stepNames:['Початок','Територія','Культура','Умови','Результати'],
  cropNames:{wheat:'Яра пшениця',soy:'Соя',corn:'Кукурудза',sorghum:'Сорго',barley:'Ярий ячмінь',oats:'Овес',cotton:'Бавовник'},
  cropDefaults:{wheat:'03-15',soy:'05-01',corn:'05-01',sorghum:'05-15',barley:'03-15',oats:'03-15',cotton:'04-20'},
  planningReadiness:{
    title:'Доступна історична оцінка, а не план майбутніх робіт',
    sowing:'Дата майбутньої сівби: недостатньо даних.',
    irrigation:'Рекомендована кількість поливу: недостатньо даних.',
    reason:'Для рекомендацій потрібен повний набір перевірених даних: прогноз, поточна температура й волога ґрунту та місцеві агрономічні правила. Історичний календар не є рекомендацією для нового сезону.'
  },
  cropNotes:{
    wheat:{season:'135 дн.',temp:'12–24 °C',note:'Рання сівба; чутлива до тривалої спеки > 35 °C.'},
    soy:{season:'140 дн.',temp:'20–30 °C',note:'Теплолюбна олійна й бобова культура для весняно-літнього сезону.'},
    corn:{season:'150 дн.',temp:'18–30 °C',note:'Висока потреба у воді; сильно реагує на полив у посушливих районах.'},
    sorghum:{season:'130 дн.',temp:'20–32 °C',note:'Посухо- та жаростійке зернове для степової зони (поріг спеки 39 °C).'},
    barley:{season:'125 дн.',temp:'11–23 °C',note:'Скоростигла рання зернова культура з меншим ризиком потрапити під спеку.'},
    oats:{season:'130 дн.',temp:'10–22 °C',note:'Полюбляє прохолодніший старт весни та помірне зволоження.'},
    cotton:{season:'180 дн.',temp:'22–33 °C',note:'Довгий теплий сезон; економіка USDA ERS у доларах за фунт.'}
  },
  statuses:{good:'Підходить',conditional:'Є обмеження',poor:'Не підходить',unknown:'Без даних',excluded:'Поза аналізом'},
  statusInfo:{
    good:'За доступними даними та умовами розрахунку ця територія має сприятливу оцінку.',
    conditional:'Розрахунок показує обмеження. Перевірте, які саме умови впливають на результат.',
    poor:'За обраних умов один або декілька чинників суттєво обмежують придатність.',
    unknown:'Не вистачає обов’язкових даних для розрахунку. Це не означає, що земля непридатна.',
    excluded:'У точці перевірки USDA CDL визначено покрив, який не входить до аналізу вирощування: наприклад воду, забудову, ліс, заболочену територію чи сніг. Оцінку придатності для цієї зони призупинено.'
  },
  factorNames:{temperature:'Температурні умови',water:'Доступність води',ph:'Кислотність ґрунту',awc:'Утримання вологи ґрунтом',drainage:'Відведення води',slope:'Нахил поверхні',texture:'Склад ґрунту'},
  missingNames:{climate:'Погода NASA',climate_coordinates:'Координати кліматичних даних',complete_season:'Повний сезон погоди',soil:'Ґрунтові дані USDA',soil_0_30cm:'Повний профіль ґрунту 0–30 см',temperature:'Температурні умови',water:'Водний баланс',ph:'Кислотність ґрунту',awc:'Водоутримання ґрунту',drainage:'Дренаж',slope:'Нахил',texture:'Склад ґрунту',landcover:'Покрив території USDA CDL'},
  landcoverCategories:{cropland:'Орні землі',pasture:'Пасовища та трав’яний покрив',water:'Водойми',urban:'Забудова',forest:'Ліс',wetland:'Заболочені землі',snow:'Сніг або лід',other:'Інший покрив',unknown:'Без даних'},
  irrigationNames:{no:'Без поливу',yes:'Полив доступний',unknown:'Ще не знаю'},
  drainageNames:{'Excessively drained':'Надмірне відведення води','Somewhat excessively drained':'Дещо надмірне відведення води','Well drained':'Добре відведення води','Moderately well drained':'Помірне відведення води','Somewhat poorly drained':'Дещо недостатнє відведення води','Poorly drained':'Недостатнє відведення води','Very poorly drained':'Дуже слабке відведення води'}
};
export const tr = (key, fallback='') => key.split('.').reduce((value,part)=>value?.[part],copy) ?? fallback;
export const fmt = (number,digits=0) => Number.isFinite(Number(number)) && number!==null && number!=='' ? new Intl.NumberFormat(locale,{maximumFractionDigits:digits}).format(Number(number)) : 'Без даних';
export function dateTime(value) {
  if(!value || Number.isNaN(Date.parse(value))) return 'Ще не отримано';
  return new Intl.DateTimeFormat(locale,{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));
}

// Presentation guards shared with the form. These preserve the distinction
// between a historical scenario and an evidence-backed future recommendation.
export function historicalScenarioDate(crop, year, asOfYear=new Date().getUTCFullYear()) {
  const numericYear=Number(year);
  if(typeof year==='boolean'||!Number.isInteger(numericYear)||numericYear<1984||numericYear>asOfYear||!copy.cropDefaults[crop])return null;
  return `${numericYear}-${copy.cropDefaults[crop]}`;
}

export function irrigationInputState(mode, value) {
  const supplied=value!==null&&value!==undefined&&String(value).trim()!=='';
  const amount=Number(value);
  const valid=mode!=='yes'||!supplied||(Number.isFinite(amount)&&amount>=0&&amount<=5000);
  return {
    valid,
    amountMm:valid&&mode==='yes'&&supplied?amount:0,
    known:valid&&(mode==='no'||(mode==='yes'&&supplied)),
    source:mode==='no'?'rainfed':mode==='yes'&&supplied&&valid?'user':'unknown'
  };
}

export function forecastOverview(forecast, now=Date.now()) {
  if(forecast?.available!==true||!forecast.data)return null;
  const periods=(forecast.data.periods||[]).filter(period=>
    Number.isFinite(Date.parse(period.start))&&Number.isFinite(Date.parse(period.end))&&
    Date.parse(period.end)>now&&Date.parse(period.start)<now+24*60*60*1000
  );
  if(!periods.length)return null;
  const temperatures=periods.map(period=>period.air_temperature_c).filter(value=>typeof value==='number'&&Number.isFinite(value));
  const rainProbabilities=periods.map(period=>period.precipitation_probability_pct).filter(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100);
  return {
    periodCount:periods.length,
    temperatureRangeC:temperatures.length?[Math.min(...temperatures),Math.max(...temperatures)]:null,
    maxRainProbabilityPct:rainProbabilities.length?Math.max(...rainProbabilities):null,
    issuedAt:forecast.data.issued_at,
    validTo:forecast.data.valid_to
  };
}

export function agronomicRuleOverview(registry) {
  const rule=registry?.rule;
  if(!rule)return null;
  const numeric=value=>typeof value==='number'&&Number.isFinite(value);
  const range=rule.threshold_temperature_range_C;
  const temperatureRangeC=Array.isArray(range)&&range.length===2&&range.every(numeric)&&range[0]<=range[1]
    ?range:numeric(rule.threshold_temperature_C)?[rule.threshold_temperature_C,rule.threshold_temperature_C]:null;
  return {
    temperatureRangeC,
    depthCm:numeric(rule.measurement_depth_cm)?rule.measurement_depth_cm:null,
    localGuideDiscouragesCrop:registry.blockers?.includes('crop_not_recommended_by_local_guide')||false,
    sourceUrl:rule.source_url,
    verifiedAt:registry.verified_at||rule.verified_at||null
  };
}
