// Navigate only the original demonstration. No Docker, Git or application API calls.
(() => {
    const screen = new URLSearchParams(location.search).get('screen');
    const names = { overview: 'Обзор', create: 'Новый стек', changes: 'Сравнение файлов' };
    let tries = 0;
    const start = () => {
        const button = [...document.querySelectorAll('.scene-nav button')].find(el => el.textContent === names[screen]);
        if (screen && button && !button.classList.contains('active') && tries++ < 40) {
            button.click();
            setTimeout(start, 100);
            return;
        }
        if (!document.querySelector('.reference-note')) {
            const note = document.createElement('footer');
            note.className = 'reference-note';
            note.innerHTML = 'Эталон Sites 01 · Демонстрационные данные · Docker и Git не подключены <a href="system.html">Дизайн-система и план</a> <a href="?screen=overview">Обзор</a> <a href="?screen=create">Новый стек</a> <a href="?screen=changes">Сравнение</a>';
            document.body.append(note);
        }
    };
    setTimeout(start, 250);
})();
