// 这是一个代码文件，会使用 Monaco（VSCode 同源编辑器）打开
use std::collections::HashMap;

fn count_words(text: &str) -> HashMap<&str, usize> {
    let mut map = HashMap::new();
    for word in text.split_whitespace() {
        *map.entry(word).or_insert(0) += 1;
    }
    map
}

fn main() {
    let text = "hello world hello";
    println!("{:?}", count_words(text));
}
