// Ukrainian first. A later English dictionary can use these same keys.
export const locale = 'uk-UA';
export const copy = {
  brandTag:'Ваша земля. Зрозумілий вибір.', title:'Що посадити. Де виростити.',
  stepNames:['Вітання','Культура','Полив і умови','Карта й територія'],
  cropNames:{wheat:'Яра пшениця',soy:'Соя',corn:'Кукурудза',sorghum:'Сорго',barley:'Ярий ячмінь',oats:'Овес',cotton:'Бавовник'},
  cropDefaults:{wheat:'03-15',soy:'05-01',corn:'05-01',sorghum:'05-15',barley:'03-15',oats:'03-15',cotton:'04-20'},
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
