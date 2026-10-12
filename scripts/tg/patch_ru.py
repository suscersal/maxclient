#!/usr/bin/env python3
"""Русский язык для static/tg: вшивает ru.json поверх английских таблиц lang-*.js,
ставит langPackCode=ru и поднимает langPackLocalVersion (сбрасывает кэшированный en-пакет).
Идемпотентно. Запуск из корня репо: python3 scripts/tg/patch_ru.py"""
import os, re, json, glob
HERE = os.path.dirname(os.path.abspath(__file__)); TG = os.path.join(HERE, '..', '..', 'static', 'tg')
ru = json.load(open(os.path.join(HERE, 'ru.json'), encoding='utf8'))
def tpl(s): return '`' + s.replace('\\', '\\\\').replace('`', '\\`').replace('${', '\\${') + '`'
def lit(v):
    if isinstance(v, str): return tpl(v)
    return '{' + ','.join('%s:%s' % (k, tpl(x)) for k, x in v.items()) + '}'
body = '{' + ','.join('%s:%s' % (json.dumps(k), lit(v)) for k, v in ru.items()) + '}'
B, E = '/*RU*/', '/*END RU*/'
for p in glob.glob(os.path.join(TG, 'lang-*.js')):
    s = open(p, encoding='utf8').read()
    if B in s:
        a = s.index(B); b = s.index(E) + len(E); s = s[:a] + s[b:]
    m = re.search(r'\};?export\{e as default\}', s)
    assert m, p
    s = s[:m.start()] + '};' + B + 'Object.assign(e,' + body + ');' + E + 'export{e as default}' + s[m.end():]
    open(p, 'w', encoding='utf8').write(s); print('lang', os.path.basename(p))
for p in glob.glob(os.path.join(TG, '*.js')):
    s = open(p, encoding='utf8').read(); o = s
    if 'langPackCode:`en`' in s: s = s.replace('langPackCode:`en`', 'langPackCode:`ru`')
    s = s.replace('langPackLocalVersion:2,', 'langPackLocalVersion:3,')
    if s != o: open(p, 'w', encoding='utf8').write(s); print('const', os.path.basename(p))
p = os.path.join(TG, 'index.html'); s = open(p, encoding='utf8').read()
s = re.sub(r'<html lang="[^"]*"', '<html lang="ru"', s, 1); open(p, 'w', encoding='utf8').write(s)
