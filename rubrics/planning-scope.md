---
name: planning-scope
description: 要件の段(scope.md、scope.slides.md)
---
- [must] SC1: 機能一覧の表があり、すべての機能に、効くペルソナと課題、優先度(Must / Should / Could)がある
- [must] SC2: 承認された strategy.md のペルソナと課題に対応しない機能が無い
- [must] SC3: ユーザーストーリーがすべて「<ペルソナ>として、<目的>のために、<したいこと>」の形で、それぞれに受け入れ条件がある
- [must] SC4: 受け入れ条件がすべて Given / When / Then の形で、検証できる(「使いやすい」など主観の語だけの条件が無い)
- [must] SC5: 受け入れ条件に、境界値(0件、上限、空の入力など)か失敗の場合が1つ以上ある
- [must] SC6: スコープ外が1つ以上あり、それぞれに理由がある
- [should] SC7: 個人情報を扱うなら、その扱い(保存する項目、見せる範囲)が非機能の要件に書かれている
- [should] SC8: 既存サービスの新機能なら、変えてはいけない既存の機能・データが書かれている
- [should] SC9: scope.slides.md があり、scope.md と食い違っていない
