/**
 * Тарифы WB для «Мастерской 3D».
 * Раз в неделю берёт комиссии и тарифы логистики из API Wildberries,
 * пишет письмо, если по вашим предметам что-то изменилось,
 * и отдаёт свежие данные приложению по ссылке (веб-приложение).
 *
 * Ключ WB хранится только в настройках этого скрипта (Свойства скрипта),
 * в таблицу и в приложение он не попадает.
 */

var API = 'https://common-api.wildberries.ru';
var TZ = 'Europe/Moscow';
var SH = { comm: 'Комиссии', wh: 'Логистика', track: 'Мои предметы', hist: 'История' };
var MODELS = { fbs: 'FBS (маркетплейс)', dbs: 'DBS (витрина)', edbs: 'DBS экспресс', fbw: 'FBW (склад WB)' };

/* ---------------- меню ---------------- */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('WB тарифы')
    .addItem('1. Ввести ключ WB и запустить', 'menuSetToken')
    .addItem('Обновить сейчас', 'menuRefresh')
    .addItem('Проверить связь с WB', 'menuCheck')
    .addToUi();
}

function menuSetToken() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('Ключ WB', 'Вставьте ключ из кабинета WB (Настройки → Доступ к API, категория «Тарифы»):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var t = String(r.getResponseText() || '').trim();
  if (t.length < 20) { ui.alert('Ключ слишком короткий. Скопируйте его целиком.'); return; }
  PropertiesService.getScriptProperties().setProperty('WB_TOKEN', t);
  ensureSheets_();
  ensureTrigger_();
  try {
    var res = refresh();
    ui.alert('Готово', 'Загружено предметов: ' + res.subjects + ', складов: ' + res.warehouses +
      '.\nЕженедельное обновление включено: понедельник, 9:00 по Москве.\n\n' +
      'Следующий шаг: Развернуть → Новое развертывание → Веб-приложение (см. инструкцию).', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Ключ сохранён, но WB ответил ошибкой:\n' + e.message);
  }
}

function menuRefresh() {
  var ui = SpreadsheetApp.getUi();
  try {
    var res = refresh();
    ui.alert('Обновлено', 'Предметов: ' + res.subjects + ', складов: ' + res.warehouses +
      '.\nИзменений по вашим предметам: ' + res.changes + (res.changes ? ' (письмо отправлено).' : '.'), ui.ButtonSet.OK);
  } catch (e) { ui.alert('Ошибка: ' + e.message); }
}

function menuCheck() {
  var ui = SpreadsheetApp.getUi();
  var t = token_();
  var exp = tokenExpiry_(t);
  var msg = t ? 'Ключ сохранён.' : 'Ключ не введён.';
  if (exp) msg += '\nКлюч действует до ' + Utilities.formatDate(exp, TZ, 'dd.MM.yyyy') + '.';
  var last = setting_('updated');
  msg += '\nПоследнее обновление: ' + (last || 'ещё не было');
  msg += '\nВеб-приложение: ' + (ScriptApp.getService().getUrl() || 'ещё не развёрнуто');
  ui.alert('Проверка', msg, ui.ButtonSet.OK);
}

/* ---------------- загрузка из WB ---------------- */
function wbGet_(path) {
  var t = token_();
  if (!t) throw new Error('Не введён ключ WB. Меню «WB тарифы» → «1. Ввести ключ WB».');
  var r = UrlFetchApp.fetch(API + path, { method: 'get', headers: { Authorization: t }, muteHttpExceptions: true });
  var code = r.getResponseCode();
  if (code === 401) throw new Error('WB не принял ключ (401). Возможно, срок ключа истёк — создайте новый и введите его через меню.');
  if (code === 429) throw new Error('WB просит подождать (лимит запросов). Повторите через минуту.');
  if (code >= 300) throw new Error('WB ответил кодом ' + code + ': ' + r.getContentText().slice(0, 200));
  return JSON.parse(r.getContentText());
}

function refresh() {
  ensureSheets_();
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var commJson = wbGet_('/api/v1/tariffs/commission?locale=ru');
  var boxJson = wbGet_('/api/v1/tariffs/box?date=' + today);

  var subjects = parseCommissions(commJson);
  var box = parseBox(boxJson);
  if (!subjects.length) throw new Error('WB вернул пустой список комиссий.');

  var ss = SpreadsheetApp.getActive();
  writeRows_(ss.getSheetByName(SH.comm),
    ['ID предмета', 'Предмет', 'Категория', 'FBS %', 'DBS %', 'DBS экспресс %', 'FBW %'],
    subjects.map(function (s) { return [s.id, s.name, s.parent, s.fbs, s.dbs, s.edbs, s.fbw]; }));
  writeRows_(ss.getSheetByName(SH.wh),
    ['Склад', 'Регион', 'FBS 1-й литр ₽', 'FBS доп. литр ₽', 'FBW 1-й литр ₽', 'FBW доп. литр ₽'],
    box.warehouses.map(function (w) { return [w.name, w.geo, w.fbs1, w.fbsL, w.fbw1, w.fbwL]; }));

  // сравнение с прошлой неделей по вашим предметам и складу
  var model = setting_('model') || 'fbs';
  var whName = setting_('warehouse') || '';
  var tracked = readTracked_();
  var prevWh = JSON.parse(setting_('whSnapshot') || 'null');
  var curWh = pickWarehouse(box.warehouses, whName);
  var diff = diffTariffs(tracked, subjects, model, prevWh, curWh);

  // обновить «Мои предметы» текущими значениями
  var bySubj = {};
  subjects.forEach(function (s) { bySubj[s.id] = s; });
  var trackSheet = ss.getSheetByName(SH.track);
  writeRows_(trackSheet, ['ID предмета', 'Предмет', 'Комиссия % (' + MODELS[model] + ')', 'Проверено'],
    tracked.map(function (t) {
      var s = bySubj[t.id];
      return [t.id, s ? s.name : t.name, s ? s[model] : '', today];
    }));
  if (curWh) setSetting_('whSnapshot', JSON.stringify(curWh));
  setSetting_('updated', new Date().toISOString());
  setSetting_('boxNext', box.dtNext || '');

  if (diff.length) {
    var hist = ss.getSheetByName(SH.hist);
    diff.forEach(function (d) { hist.appendRow([today, d.what, d.before, d.after]); });
    sendMail_('WB: изменились тарифы по вашим товарам',
      'Изменения на ' + Utilities.formatDate(new Date(), TZ, 'dd.MM.yyyy') + ':\n\n' +
      diff.map(function (d) { return '• ' + d.what + ': было ' + d.before + ', стало ' + d.after; }).join('\n') +
      '\n\nОткройте «Мастерскую 3D» → «Изделия» → «Тарифы WB», чтобы пересчитать цены.');
  }
  checkTokenExpiry_();
  return { subjects: subjects.length, warehouses: box.warehouses.length, changes: diff.length };
}

/* ---------------- чистые функции (проверяются отдельно) ---------------- */
function num_(v) {
  if (v === null || v === undefined || v === '' || v === '-') return null;
  var n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isFinite(n) ? n : null;
}

function parseCommissions(json) {
  var rows = (json && (json.report || json.data || json.response && json.response.report)) || [];
  return rows.map(function (r) {
    return {
      id: r.subjectID, name: r.subjectName || '', parent: r.parentName || '',
      fbs: num_(r.kgvpMarketplace), dbs: num_(r.kgvpSupplier),
      edbs: num_(r.kgvpSupplierExpress), fbw: num_(r.paidStorageKgvp)
    };
  }).filter(function (s) { return s.id; });
}

function parseBox(json) {
  var d = (json && json.response && json.response.data) || (json && json.data) || {};
  var list = d.warehouseList || [];
  return {
    dtNext: d.dtNextBox || '',
    warehouses: list.map(function (w) {
      var fbw1 = num_(w.boxDeliveryBase), fbwL = num_(w.boxDeliveryLiter);
      var mb1 = num_(w.boxDeliveryMarketplaceBase), mbL = num_(w.boxDeliveryMarketplaceLiter);
      return {
        name: w.warehouseName || '', geo: w.geoName || '',
        fbs1: mb1 !== null ? mb1 : fbw1, fbsL: mbL !== null ? mbL : fbwL,
        fbw1: fbw1, fbwL: fbwL
      };
    }).filter(function (w) { return w.name; })
  };
}

function pickWarehouse(list, name) {
  if (!list || !list.length) return null;
  var w = null;
  if (name) w = list.filter(function (x) { return x.name === name; })[0];
  if (!w) w = list.filter(function (x) { return /маркетплейс/i.test(x.name); })[0];
  return w || list[0];
}

function diffTariffs(tracked, subjects, model, prevWh, curWh) {
  var out = [], by = {};
  subjects.forEach(function (s) { by[s.id] = s; });
  tracked.forEach(function (t) {
    var s = by[t.id];
    if (!s) return;
    var now = s[model];
    if (t.last !== null && t.last !== undefined && t.last !== '' && now !== null && Number(t.last) !== Number(now)) {
      out.push({ what: 'Комиссия «' + s.name + '»', before: t.last + '%', after: now + '%' });
    }
  });
  if (prevWh && curWh && prevWh.name === curWh.name) {
    if (prevWh.fbs1 !== curWh.fbs1) out.push({ what: 'Логистика, 1-й литр (' + curWh.name + ')', before: prevWh.fbs1 + ' ₽', after: curWh.fbs1 + ' ₽' });
    if (prevWh.fbsL !== curWh.fbsL) out.push({ what: 'Логистика, доп. литр (' + curWh.name + ')', before: prevWh.fbsL + ' ₽', after: curWh.fbsL + ' ₽' });
  }
  return out;
}

function buildPayload(subjects, warehouses, updated, model, warehouse) {
  return {
    ok: true, v: 1, updated: updated, model: model, warehouse: warehouse,
    cols: ['id', 'name', 'parent', 'fbs', 'dbs', 'edbs', 'fbw'],
    subjects: subjects.map(function (s) { return [s.id, s.name, s.parent, s.fbs, s.dbs, s.edbs, s.fbw]; }),
    warehouses: warehouses
  };
}

/* ---------------- выдача данных приложению ---------------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    ensureSheets_();
    if (p.model && MODELS[p.model]) setSetting_('model', p.model);
    if (p.wh !== undefined && p.wh !== '') setSetting_('warehouse', String(p.wh).slice(0, 100));
    if (p.track) saveTracked_(String(p.track));
    var ss = SpreadsheetApp.getActive();
    var subjects = readRows_(ss.getSheetByName(SH.comm)).map(function (r) {
      return { id: r[0], name: r[1], parent: r[2], fbs: num_(r[3]), dbs: num_(r[4]), edbs: num_(r[5]), fbw: num_(r[6]) };
    });
    var warehouses = readRows_(ss.getSheetByName(SH.wh)).map(function (r) {
      return { name: r[0], geo: r[1], fbs1: num_(r[2]), fbsL: num_(r[3]), fbw1: num_(r[4]), fbwL: num_(r[5]) };
    });
    if (!subjects.length) return json_({ ok: false, error: 'В таблице ещё нет данных. Запустите «WB тарифы → Обновить сейчас».' });
    return json_(buildPayload(subjects, warehouses, setting_('updated'), setting_('model') || 'fbs', setting_('warehouse') || ''));
  } catch (err) {
    return json_({ ok: false, error: err.message });
  }
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------- служебное ---------------- */
function token_() { return PropertiesService.getScriptProperties().getProperty('WB_TOKEN') || ''; }

function tokenExpiry_(t) {
  try {
    var part = String(t).split('.')[1];
    if (!part) return null;
    while (part.length % 4) part += '=';
    var data = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(part)).getDataAsString());
    return data.exp ? new Date(data.exp * 1000) : null;
  } catch (e) { return null; }
}

function checkTokenExpiry_() {
  var exp = tokenExpiry_(token_());
  if (!exp) return;
  var days = Math.floor((exp - new Date()) / 86400000);
  if (days <= 14) {
    sendMail_('WB: ключ API скоро закончится',
      'Ключ WB для обновления тарифов действует ещё ' + Math.max(0, days) + ' дн. (до ' +
      Utilities.formatDate(exp, TZ, 'dd.MM.yyyy') + ').\n\nСоздайте новый ключ в кабинете WB (Настройки → Доступ к API, категория «Тарифы») ' +
      'и введите его в таблице: меню «WB тарифы» → «1. Ввести ключ WB».');
  }
}

function sendMail_(subject, body) {
  var to = Session.getEffectiveUser().getEmail();
  if (to) MailApp.sendEmail(to, subject, body);
}

function ensureSheets_() {
  var ss = SpreadsheetApp.getActive();
  [SH.comm, SH.wh, SH.track, SH.hist].forEach(function (n) {
    if (!ss.getSheetByName(n)) {
      var s = ss.insertSheet(n);
      if (n === SH.hist) s.appendRow(['Дата', 'Что', 'Было', 'Стало']);
      s.setFrozenRows(1);
    }
  });
}

function ensureTrigger_() {
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'weeklyRun'; });
  if (!has) ScriptApp.newTrigger('weeklyRun').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).inTimezone(TZ).create();
}

function weeklyRun() {
  try { refresh(); }
  catch (e) { sendMail_('WB: не удалось обновить тарифы', 'Еженедельное обновление не прошло:\n' + e.message); }
}

function writeRows_(sheet, header, rows) {
  sheet.clearContents();
  sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) sheet.getRange(2, 1, rows.length, header.length).setValues(rows.map(function (r) {
    return r.map(function (v) { return v === null || v === undefined ? '' : v; });
  }));
}

function readRows_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
}

function readTracked_() {
  var ss = SpreadsheetApp.getActive();
  return readRows_(ss.getSheetByName(SH.track)).map(function (r) {
    return { id: Number(r[0]), name: r[1], last: r[2] === '' ? null : Number(r[2]) };
  }).filter(function (t) { return t.id; });
}

function saveTracked_(csv) {
  var ids = csv.split(',').map(function (x) { return Number(x); }).filter(function (x) { return x > 0; }).slice(0, 500);
  if (!ids.length) return;
  var ss = SpreadsheetApp.getActive();
  var model = setting_('model') || 'fbs';
  var old = {};
  readTracked_().forEach(function (t) { old[t.id] = t; });
  var by = {};
  readRows_(ss.getSheetByName(SH.comm)).forEach(function (r) { by[Number(r[0])] = r; });
  var col = { fbs: 3, dbs: 4, edbs: 5, fbw: 6 }[model];
  var today = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  writeRows_(ss.getSheetByName(SH.track), ['ID предмета', 'Предмет', 'Комиссия % (' + MODELS[model] + ')', 'Проверено'],
    ids.map(function (id) {
      if (old[id]) return [id, old[id].name, old[id].last === null ? '' : old[id].last, today];
      var r = by[id];
      return [id, r ? r[1] : '', r ? r[col] : '', today];
    }));
}

function setting_(key) {
  return PropertiesService.getScriptProperties().getProperty('S_' + key) || '';
}

function setSetting_(key, val) {
  PropertiesService.getScriptProperties().setProperty('S_' + key, String(val));
}
