import os, glob

for f in glob.glob('worker/src/**/*.ts', recursive=True):
    with open(f, 'r', encoding='utf-8') as file:
        content = file.read()
    
    new_content = content.replace('\\`', '`')
    
    if content != new_content:
        with open(f, 'w', encoding='utf-8') as file:
            file.write(new_content)
        print(f'Fixed {f}')
