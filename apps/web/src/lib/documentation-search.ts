const maximumDocumentationSearchLength = 200;
const controlCharacters = /[\u0000-\u001f\u007f]/u;

export function validDocumentationSearchQuery(query: string): boolean {
  return (
    query.length <= maximumDocumentationSearchLength &&
    !controlCharacters.test(query)
  );
}
