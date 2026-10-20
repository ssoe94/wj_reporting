"""A single edit may suggest a known ID, never automatically correct it."""
def within_one(left,right):
    if abs(len(left)-len(right))>1:return False
    if len(left)>len(right):left,right=right,left
    i=j=edits=0
    while i<len(left) and j<len(right):
        if left[i]==right[j]:i+=1;j+=1;continue
        edits+=1
        if edits>1:return False
        if len(left)==len(right):i+=1
        j+=1
    return edits+(j<len(right))<=1


def candidates(primary,known):
    matches=[value for value in known if within_one(primary,value)]
    return matches if len(matches)==1 else []
